/**
 * Imports parts and part variants from the merchant's spreadsheet, saved as
 * CSV. Port of Parts::CsvImport. One row per variant:
 *
 *   part_name, part_sku, unit, pack_size, cost_per_unit, reorder_level,
 *   reorder_quantity, model, size, colour, variant_sku, on_hand
 *
 * Parts match on part_sku, else on name (a part that has no SKU yet);
 * variants on variant_sku, else on their model / size / colour. Blank part
 * fields leave what's there. Modes:
 *   parts  add / update parts and variants; on_hand is ignored
 *   stock  also set each variant's on-hand to the file's count, recorded as a
 *          stock_count movement for the difference (blank on_hand = not counted)
 *
 * `await CsvImport.build(...)`, check `errors` and `summary()` (the preview),
 * then `apply()`, which writes everything in one transaction, or nothing.
 * Build a fresh one to apply, so it's checked against the shop's parts as
 * they are by then.
 */
import { Prisma, type Part, type PartVariant } from "@prisma/client";
import prisma from "../../db.server";
import { generateCsv, MalformedCsvError, parseCsv } from "../../lib/csv";
import { type Db, withRowLock } from "../../lib/db-lock.server";
import { PART_IMPORT_MODES } from "../../models/part-import.server";
import { createPart, OPTION_NAMES, partOptionNames, updatePart } from "../../models/part.server";
import {
  createPartVariant,
  moveStock,
  normalizeOptionValue,
  variantFullLabel,
  variantMatches,
} from "../../models/part-variant.server";

export const CSV_COLUMNS = [
  "part_name", "part_sku", "unit", "pack_size", "cost_per_unit", "reorder_level",
  "reorder_quantity", "model", "size", "colour", "variant_sku", "on_hand",
];
const PART_FIELDS = ["unit", "pack_size", "cost_per_unit", "reorder_level", "reorder_quantity"] as const;
type PartField = (typeof PART_FIELDS)[number];
const FIELD_ATTR: Record<PartField, "unit" | "packSize" | "costPerUnit" | "reorderLevel" | "reorderQuantity"> = {
  unit: "unit",
  pack_size: "packSize",
  cost_per_unit: "costPerUnit",
  reorder_level: "reorderLevel",
  reorder_quantity: "reorderQuantity",
};

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 5_000;
const UNIT_ALIASES: Record<string, string> = {
  each: "each", ea: "each", unit: "each", units: "each",
  pair: "pair", pairs: "pair",
  metre: "metre", metres: "metre", meter: "metre", meters: "metre", m: "metre",
  ml: "ml", millilitre: "ml", millilitres: "ml",
  g: "g", gram: "g", grams: "g",
};

/** Applying an import with errors (Rails CsvImport::Invalid). */
export class InvalidImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidImportError";
  }
}

export interface RowError {
  row: number | null;
  message: string;
}

export interface StockChange {
  partName: string;
  variantLabel: string;
  from: Prisma.Decimal;
  to: Prisma.Decimal;
  delta: Prisma.Decimal;
}

export interface ImportSummary {
  rows: number;
  parts_created: number;
  parts_updated: number;
  variants_created: number;
  variants_updated: number;
  stock_changes: number;
  errors: number;
}

type PartWithVariants = Part & { variants: PartVariant[] };
type FieldValue = string | Prisma.Decimal;

interface VariantPlan {
  row: number;
  record: PartVariant | null;
  options: Record<string, string>;
  sku: string | null;
  onHand: Prisma.Decimal | null;
}

interface PartPlan {
  record: PartWithVariants | null;
  name: string | null;
  sku: string | null;
  attrs: Partial<Record<PartField, FieldValue>>;
  optionNames: string[];
  variants: VariantPlan[];
  row: number;
}

const planLabel = (plan: PartPlan) => plan.name ?? plan.record?.name ?? plan.sku ?? "";
const key = (value: string | null | undefined) => normalizeOptionValue(value);
const fieldEquals = (a: FieldValue | undefined, b: FieldValue | undefined) =>
  a instanceof Prisma.Decimal && b instanceof Prisma.Decimal ? a.eq(b) : a === b;

/**
 * Uploaded bytes as UTF-8 text: without Excel's byte-order mark, and read as
 * Windows-1252 if they aren't UTF-8 (an older Excel export).
 */
export function utf8(bytes: Uint8Array | string): string {
  let text: string;
  if (typeof bytes === "string") {
    text = bytes;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder("windows-1252").decode(bytes);
    }
  }
  return text.replace(/^\uFEFF/, "").split(String.fromCharCode(0)).join("");
}

export function templateCsv(): string {
  return generateCsv([
    CSV_COLUMNS,
    ["Commando sole", "SOLE-CMD", "pair", "1", "12.50", "2", "10", "Commando", "UK 7", "Black", "SOLE-CMD-7-BLK", "6"],
    ["Commando sole", "SOLE-CMD", "pair", "1", "12.50", "2", "10", "Commando", "UK 8", "Black", "SOLE-CMD-8-BLK", "4"],
    ["Adhesive", "GLUE-500", "ml", "500", "0.02", "200", "1000", "", "", "", "", "1500"],
  ]);
}

export interface CsvImportOptions {
  mode: string;
  filename?: string | null;
  db?: Db;
  maxRows?: number;
}

export class CsvImport {
  readonly errors: RowError[] = [];
  readonly stockChanges: StockChange[] = [];
  private plans: PartPlan[] = [];
  private rowCount = 0;
  private partsBySku = new Map<string, PartWithVariants>();
  private partsByName = new Map<string, PartWithVariants[]>();
  private variantsBySku = new Map<string, PartVariant & { part: Part }>();
  private readonly mode: string;
  private readonly filename: string;
  private readonly db: Db;
  private readonly maxRows: number;

  private constructor(
    private readonly shopId: number,
    private readonly text: string,
    options: CsvImportOptions,
  ) {
    this.mode = options.mode;
    this.filename = options.filename?.trim() || "import.csv";
    this.db = options.db ?? prisma;
    this.maxRows = options.maxRows ?? MAX_ROWS;
  }

  static async build(
    shopId: number,
    text: string | Uint8Array,
    options: CsvImportOptions,
  ): Promise<CsvImport> {
    const raw = typeof text === "string" ? text : utf8(text);
    const importer = new CsvImport(shopId, raw, options);
    await importer.load();
    return importer;
  }

  get valid(): boolean {
    return this.errors.length === 0;
  }

  get stockMode(): boolean {
    return this.mode === "stock";
  }

  private get variantPlans(): VariantPlan[] {
    return this.plans.flatMap((plan) => plan.variants);
  }

  /** What applying would do: counts for the preview. */
  summary(): ImportSummary {
    return {
      rows: this.rowCount,
      parts_created: this.plans.filter((p) => p.record === null).length,
      parts_updated: this.plans.filter((p) => p.record && Object.keys(this.partChanges(p)).length > 0).length,
      variants_created: this.variantPlans.filter((v) => v.record === null).length,
      variants_updated: this.variantPlans.filter((v) => v.record && v.sku && v.sku !== v.record.sku).length,
      stock_changes: this.stockChanges.length,
      errors: this.errors.length,
    };
  }

  /**
   * Writes the import in one transaction. Throws InvalidImportError (and
   * writes nothing) if the file has errors against the shop's parts as they are now.
   */
  async apply({ by = null }: { by?: string | null } = {}): Promise<ImportSummary> {
    if (!this.valid) {
      const n = this.errors.length;
      throw new InvalidImportError(`The file has ${n} ${n === 1 ? "error" : "errors"}`);
    }
    const run = async (tx: Prisma.TransactionClient) => {
      for (const plan of this.plans) await this.applyPart(tx, plan, by);
    };
    if ("$transaction" in this.db) {
      await (this.db as typeof prisma).$transaction(run, { timeout: 60_000, maxWait: 10_000 });
    } else {
      await run(this.db as Prisma.TransactionClient);
    }
    return this.summary();
  }

  // ---------- Reading the file ----------

  private async load(): Promise<void> {
    const rows = this.readRows();
    if (!rows) return;
    await this.loadExisting();
    rows.forEach((row, index) => this.addRow(row, index + 2)); // row 1 is the header
    for (const plan of this.plans) this.resolve(plan);
    this.checkVariantSkus();
    if (this.stockMode) this.collectStockChanges();
  }

  private fileError(message: string): null {
    this.errors.push({ row: null, message });
    return null;
  }

  private readRows(): Record<string, string | null>[] | null {
    if (!(PART_IMPORT_MODES as readonly string[]).includes(this.mode)) {
      return this.fileError("Choose how to import the file.");
    }
    if (Buffer.byteLength(this.text) > MAX_BYTES) {
      return this.fileError(`The file is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
    }
    const text = utf8(this.text);
    const header = text.split(/\r?\n/, 1)[0] ?? "";
    const separator = (header.match(/;/g)?.length ?? 0) > (header.match(/,/g)?.length ?? 0) ? ";" : ",";
    let table: string[][];
    try {
      table = parseCsv(text, separator);
    } catch (error) {
      if (error instanceof MalformedCsvError) {
        return this.fileError(`That doesn't look like a CSV file (${error.message}).`);
      }
      throw error;
    }
    // skip_blanks: a completely empty line isn't a row.
    table = table.filter((row) => !(row.length === 1 && row[0] === ""));
    const headers = (table.shift() ?? []).map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
    if (!headers.includes("part_name")) {
      return this.fileError("The file has no part_name column. Download the template to see the columns.");
    }
    const rows = table
      .map((fields) => Object.fromEntries(headers.map((h, i) => [h, fields[i] ?? null])))
      .filter((row) => Object.values(row).some((value) => value !== null && value.trim() !== ""));
    if (rows.length === 0) return this.fileError("The file has no rows.");
    if (rows.length > this.maxRows) {
      return this.fileError(`The file has more than ${this.maxRows} rows. Split it into smaller files.`);
    }
    this.rowCount = rows.length;
    return rows;
  }

  private async loadExisting(): Promise<void> {
    const parts = await this.db.part.findMany({
      where: { shopId: this.shopId },
      include: { variants: { orderBy: { id: "asc" } } },
      orderBy: { id: "asc" },
    });
    for (const part of parts) {
      if (part.sku?.trim() && !this.partsBySku.has(key(part.sku))) this.partsBySku.set(key(part.sku), part);
      const named = this.partsByName.get(key(part.name)) ?? [];
      named.push(part);
      this.partsByName.set(key(part.name), named);
      for (const variant of part.variants) {
        if (variant.sku?.trim()) this.variantsBySku.set(key(variant.sku), { ...variant, part });
      }
    }
  }

  private cell(row: Record<string, string | null>, column: string): string | null {
    const value = row[column]?.trim();
    return value ? value : null;
  }

  private addRow(row: Record<string, string | null>, line: number): void {
    const name = this.cell(row, "part_name");
    const sku = this.cell(row, "part_sku");
    if (name === null && sku === null) {
      this.errors.push({ row: line, message: "Needs a part_name or part_sku." });
      return;
    }
    const plan = this.planFor(name, sku, line);
    if (!plan) return;
    this.readPartFields(plan, row, line);
    const options: Record<string, string> = {};
    for (const option of OPTION_NAMES) {
      const value = this.cell(row, option);
      if (value !== null) options[option] = value;
    }
    const onHand = this.stockMode ? this.number(this.cell(row, "on_hand"), "on_hand", line, 0) : null;
    plan.variants.push({ row: line, record: null, options, sku: this.cell(row, "variant_sku"), onHand });
  }

  /** The rows of one part share a plan: same part_sku, or same name when the row has no SKU. */
  private planFor(name: string | null, sku: string | null, line: number): PartPlan | null {
    let plan = this.plans.find((candidate) =>
      sku ? key(candidate.sku) === key(sku) : key(planLabel(candidate)) === key(name),
    );
    if (!plan && sku && name) {
      plan = this.plans.find((candidate) => candidate.sku === null && key(candidate.name) === key(name));
    }
    if (plan) {
      plan.sku ??= sku;
      return plan;
    }
    const record = this.existingPart(name, sku, line);
    if (record === false) return null;
    const created: PartPlan = { record, name, sku, attrs: {}, optionNames: [], variants: [], row: line };
    this.plans.push(created);
    return created;
  }

  /** An existing part by SKU, else by name if that part has no SKU yet. null for a new part; false when ambiguous. */
  private existingPart(name: string | null, sku: string | null, line: number): PartWithVariants | null | false {
    if (sku && this.partsBySku.has(key(sku))) return this.partsBySku.get(key(sku))!;
    if (name === null) return null;
    const named = (this.partsByName.get(key(name)) ?? []).filter((part) => !(sku && part.sku?.trim()));
    if (named.length <= 1) return named[0] ?? null;
    this.errors.push({
      row: line,
      message: `Several parts are called “${name}”. Add their part_sku to tell them apart.`,
    });
    return false;
  }

  private readPartFields(plan: PartPlan, row: Record<string, string | null>, line: number): void {
    for (const field of PART_FIELDS) {
      const raw = this.cell(row, field);
      if (raw === null) continue;
      const value =
        field === "unit" ? this.unit(raw, line) : this.number(raw, field, line, 0, field === "pack_size");
      if (value === null) continue;
      if (field in plan.attrs && !fieldEquals(plan.attrs[field], value)) {
        this.errors.push({ row: line, message: `${field} for ${planLabel(plan)} differs from row ${plan.row}.` });
      } else {
        plan.attrs[field] ??= value;
      }
    }
  }

  private unit(raw: string, line: number): string | null {
    const found = UNIT_ALIASES[raw.toLowerCase()];
    if (!found) {
      this.errors.push({ row: line, message: `Unknown unit “${raw}”. Use each, pair, metre, ml or g.` });
      return null;
    }
    return found;
  }

  private number(raw: string | null, field: string, line: number, min: number, positive = false): Prisma.Decimal | null {
    if (raw === null) return null;
    let cleaned = raw.replace(/ /g, "").replace(/^[£$€]/, "");
    if (/^-?\d+,\d+$/.test(cleaned)) cleaned = cleaned.replace(",", "."); // 1,5 from a European spreadsheet
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
      this.errors.push({ row: line, message: `${field} “${raw}” isn't a number.` });
      return null;
    }
    const value = new Prisma.Decimal(cleaned);
    if (positive ? value.lte(0) : value.lt(min)) {
      this.errors.push({ row: line, message: `${field} must be ${positive ? "more than 0" : `at least ${min}`}.` });
      return null;
    }
    return value;
  }

  // ---------- Matching variants ----------

  private resolve(plan: PartPlan): void {
    const record = plan.record;
    if (record === null && plan.name === null) {
      this.errors.push({ row: plan.row, message: `No part has part_sku “${plan.sku}”. Add a part_name to create it.` });
    }
    plan.optionNames = record
      ? partOptionNames(record)
      : OPTION_NAMES.filter((option) => plan.variants.some((v) => option in v.options));
    // A row with no options for a part that has them only updates the part
    // (the export writes one for a part still waiting for its variants).
    plan.variants = plan.variants.filter(
      (v) => !(plan.optionNames.length > 0 && Object.keys(v.options).length === 0 && v.sku === null && v.onHand === null),
    );
    const seen = new Map<string, number>();
    for (const variant of plan.variants) this.resolveVariant(plan, variant, seen);
  }

  private resolveVariant(plan: PartPlan, variant: VariantPlan, seen: Map<string, number>): void {
    const keys = Object.keys(variant.options);
    const unknown = keys.filter((k) => !plan.optionNames.includes(k));
    const missing = plan.optionNames.filter((k) => !keys.includes(k));
    if (unknown.length) {
      const varies = plan.optionNames.length
        ? `varies by ${plan.optionNames.join(", ")}`
        : "has no model, size or colour";
      this.errors.push({
        row: variant.row,
        message: `${planLabel(plan)} ${varies}, so ${unknown.join(" and ")} can't be set.`,
      });
      return;
    }
    if (missing.length) {
      this.errors.push({ row: variant.row, message: `${planLabel(plan)} needs a ${missing.join(" and ")} on every row.` });
      return;
    }
    const combo = JSON.stringify(plan.optionNames.map((option) => key(variant.options[option])));
    const first = seen.get(combo);
    if (first !== undefined) {
      this.errors.push({ row: variant.row, message: `Same ${planLabel(plan)} variant as row ${first}.` });
      return;
    }
    seen.set(combo, variant.row);
    variant.record = this.existingVariant(plan, variant);
  }

  /** A variant_sku can only be on one row. */
  private checkVariantSkus(): void {
    const firstRow = new Map<string, number>();
    const withSku = this.variantPlans.filter((v) => v.sku).sort((a, b) => a.row - b.row);
    for (const variant of withSku) {
      const row = firstRow.get(key(variant.sku));
      if (row !== undefined) {
        this.errors.push({ row: variant.row, message: `variant_sku “${variant.sku}” is also on row ${row}.` });
      } else {
        firstRow.set(key(variant.sku), variant.row);
      }
    }
  }

  private existingVariant(plan: PartPlan, variant: VariantPlan): PartVariant | null {
    const bySku = variant.sku ? this.variantsBySku.get(key(variant.sku)) ?? null : null;
    const byOptions =
      plan.record?.variants.find((candidate) =>
        plan.optionNames.every((option) => variantMatches(candidate, option, variant.options[option])),
      ) ?? null;
    if (bySku === null) return byOptions;
    if (plan.record === null || bySku.partId !== plan.record.id) {
      this.errors.push({
        row: variant.row,
        message: `variant_sku “${variant.sku}” already belongs to ${variantFullLabel(bySku, bySku.part)}.`,
      });
    } else if (byOptions?.id !== bySku.id) {
      this.errors.push({
        row: variant.row,
        message: `variant_sku “${variant.sku}” belongs to ${variantFullLabel(bySku, bySku.part)}, not these options.`,
      });
    }
    return bySku;
  }

  private collectStockChanges(): void {
    for (const plan of this.plans) {
      for (const variant of plan.variants) {
        if (variant.onHand === null) continue;
        const from = variant.record ? new Prisma.Decimal(variant.record.onHand) : new Prisma.Decimal(0);
        if (from.eq(variant.onHand)) continue;
        const label = plan.optionNames.map((option) => variant.options[option]).join(" · ") || "Standard";
        this.stockChanges.push({
          partName: planLabel(plan),
          variantLabel: label,
          from,
          to: variant.onHand,
          delta: variant.onHand.sub(from),
        });
      }
    }
  }

  // ---------- Applying ----------

  private partChanges(plan: PartPlan): Record<string, FieldValue> {
    const changes: Record<string, FieldValue> = {};
    for (const [field, value] of Object.entries(plan.attrs) as [PartField, FieldValue][]) {
      const current = plan.record?.[FIELD_ATTR[field]];
      if (plan.record && fieldEquals(current as FieldValue, value)) continue;
      changes[FIELD_ATTR[field]] = value;
    }
    if (plan.name && plan.name !== plan.record?.name) changes.name = plan.name;
    if (plan.sku && plan.sku !== plan.record?.sku) changes.sku = plan.sku;
    return changes;
  }

  private async applyPart(tx: Prisma.TransactionClient, plan: PartPlan, by: string | null): Promise<void> {
    const changes = this.partChanges(plan);
    const part = plan.record
      ? Object.keys(changes).length
        ? await updatePart(plan.record.id, changes, tx)
        : plan.record
      : await createPart({ shopId: this.shopId, optionNames: plan.optionNames, ...changes }, tx);
    for (const variant of plan.variants) await this.applyVariant(tx, part, variant, by);
  }

  private async applyVariant(
    tx: Prisma.TransactionClient,
    part: Part,
    plan: VariantPlan,
    by: string | null,
  ): Promise<void> {
    let variant = plan.record;
    if (!variant) {
      const names = partOptionNames(part);
      variant = names.length
        ? await createPartVariant(
            { partId: part.id, options: Object.fromEntries(names.map((n) => [n, plan.options[n]])) },
            tx,
          )
        : await tx.partVariant.findFirstOrThrow({ where: { partId: part.id }, orderBy: { id: "asc" } });
    }
    if (plan.sku && plan.sku !== variant.sku) {
      variant = await tx.partVariant.update({ where: { id: variant.id }, data: { sku: plan.sku } });
    }
    if (plan.onHand === null) return;
    await withRowLock(tx, "part_variants", variant.id);
    const { onHand } = await tx.partVariant.findUniqueOrThrow({ where: { id: variant.id } });
    const delta = plan.onHand.sub(onHand);
    if (!delta.isZero()) {
      await moveStock(variant.id, delta, { reason: "stock_count", note: `Stock count from ${this.filename}`, by }, tx);
    }
  }
}
