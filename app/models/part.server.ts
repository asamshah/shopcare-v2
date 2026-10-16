/**
 * A workshop part: soles, heels, eyelets, adhesive… Stock is counted in `unit`
 * and received in packs of `packSize` units. Parts that come in sizes or
 * models have one variant per combination. Port of Part.
 */
import { Prisma, type Part } from "@prisma/client";
import prisma from "../db.server";
import { type Db, inTransaction } from "../lib/db-lock.server";
import { createPartVariant, variantOptions } from "./part-variant.server";
import {
  assertValid,
  attributesOf,
  type DecimalInput,
  Errors,
  jsonArray,
  searchWhere,
  validateInclusion,
  validateNumber,
  validatePresence,
} from "./validation.server";

export const UNITS = ["each", "pair", "metre", "ml", "g"] as const;
export type PartUnit = (typeof UNITS)[number];
export const OPTION_NAMES = ["model", "size", "colour"] as const;
export type PartOptionName = (typeof OPTION_NAMES)[number];
export const MAX_GENERATED_VARIANTS = 500;

/** Thrown for impossible requests (Rails ArgumentError). */
export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

export interface PartInput {
  shopId: number;
  name?: string;
  sku?: string | null;
  unit?: string;
  packSize?: DecimalInput;
  costPerUnit?: DecimalInput;
  reorderLevel?: DecimalInput;
  reorderQuantity?: DecimalInput;
  optionNames?: unknown;
  notes?: string | null;
  active?: boolean;
}

const DEFAULTS = {
  unit: "each",
  packSize: 1,
  costPerUnit: 0,
  reorderLevel: 0,
  reorderQuantity: 0,
  active: true,
};

export const partOptionNames = (part: Pick<Part, "optionNames">): string[] =>
  jsonArray(part.optionNames).map(String);

/** Rails before_validation: known option names only, in the given order, no repeats. */
export function normalizeOptionNames(value: unknown): string[] {
  const list = (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value])
    .map((v) => String(v ?? ""))
    .filter((v) => v.trim() !== "");
  return [...new Set(list)].filter((v) => (OPTION_NAMES as readonly string[]).includes(v));
}

export function validatePart(part: PartInput & { optionNames: string[] }): Errors {
  const errors = new Errors();
  validatePresence(errors, "name", part.name);
  validateInclusion(errors, "unit", part.unit, UNITS);
  validateNumber(errors, "packSize", part.packSize, { greaterThan: 0 });
  for (const field of ["costPerUnit", "reorderLevel", "reorderQuantity"] as const) {
    validateNumber(errors, field, part[field], { greaterThanOrEqualTo: 0 });
  }
  if (part.optionNames.some((name) => !(OPTION_NAMES as readonly string[]).includes(name))) {
    errors.add("optionNames", "can only be model, size and colour");
  }
  return errors;
}

/** A part with no options still needs one variant to hold its stock (Rails after_save). */
async function ensureDefaultVariant(tx: Prisma.TransactionClient, part: Part): Promise<void> {
  if (partOptionNames(part).length > 0) return;
  if ((await tx.partVariant.count({ where: { partId: part.id } })) > 0) return;
  await createPartVariant({ partId: part.id, options: {} }, tx);
}

async function save(db: Db, attrs: PartInput, id?: number): Promise<Part> {
  const data = { ...DEFAULTS, ...attrs, optionNames: normalizeOptionNames(attrs.optionNames) };
  assertValid("Part", validatePart(data));
  const record = { ...data, name: data.name as string };
  return inTransaction(db, async (tx) => {
    const part = id
      ? await tx.part.update({ where: { id }, data: record })
      : await tx.part.create({ data: record });
    await ensureDefaultVariant(tx, part);
    return part;
  });
}

export function createPart(input: PartInput, db: Db = prisma): Promise<Part> {
  return save(db, input);
}

export async function updatePart(
  id: number,
  patch: Partial<Omit<PartInput, "shopId">>,
  db: Db = prisma,
): Promise<Part> {
  const current = await db.part.findUniqueOrThrow({ where: { id } });
  const attrs = attributesOf(current);
  return save(db, { ...attrs, ...patch }, id);
}

export function varies(part: Pick<Part, "optionNames">): boolean {
  return partOptionNames(part).length > 0;
}

function cartesian(lists: string[][]): string[][] {
  return lists.reduce<string[][]>(
    (combos, list) => combos.flatMap((combo) => list.map((value) => [...combo, value])),
    [[]],
  );
}

/**
 * Adds a variant for every combination of the given option values, keeping
 * the ones that already exist. `values` is { size: ["UK 6", "UK 7"], … }.
 * Returns the number of variants created.
 */
export function generateVariants(
  partId: number,
  values: Record<string, unknown>,
  db: Db = prisma,
): Promise<number> {
  return inTransaction(db, async (tx) => {
    const part = await tx.part.findUniqueOrThrow({ where: { id: partId } });
    const names = partOptionNames(part);
    const lists = names.map((name) => {
      const raw = values[name];
      const list = (Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw])
        .map((v) => String(v ?? "").trim())
        .filter((v) => v !== "");
      return [...new Set(list)];
    });
    if (lists.some((list) => list.length === 0)) return 0;

    const combos = cartesian(lists);
    if (combos.length > MAX_GENERATED_VARIANTS) {
      throw new ArgumentError(`That would create more than ${MAX_GENERATED_VARIANTS} variants`);
    }
    const variants = await tx.partVariant.findMany({ where: { partId }, orderBy: { id: "asc" } });
    const existing = new Set(
      variants.map((v) => JSON.stringify(names.map((name) => variantOptions(v)[name] ?? null))),
    );
    let created = 0;
    for (const combo of combos) {
      if (existing.has(JSON.stringify(combo))) continue;
      const options = Object.fromEntries(names.map((name, i) => [name, combo[i]]));
      await createPartVariant({ partId, options }, tx);
      created += 1;
    }
    return created;
  });
}

/** "3 pairs", "1.5 metre", "20 ml" */
export function quantityLabel(part: Pick<Part, "unit">, quantity: DecimalInput): string {
  const amount = new Prisma.Decimal(quantity);
  const text = amount.toString();
  return part.unit === "pair" && !amount.eq(1) ? `${text} pairs` : `${text} ${part.unit}`;
}

export async function totalOnHand(partId: number, db: Db = prisma): Promise<Prisma.Decimal> {
  const { _sum } = await db.partVariant.aggregate({ where: { partId }, _sum: { onHand: true } });
  return _sum.onHand ?? new Prisma.Decimal(0);
}

export const ORDERED: Prisma.PartOrderByWithRelationInput[] = [{ name: "asc" }, { id: "asc" }];

export function partSearchWhere(term: string, db: Db = prisma) {
  return searchWhere(db, "parts", ["name", "sku"], term);
}
