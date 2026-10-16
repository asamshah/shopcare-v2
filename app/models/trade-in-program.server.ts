/**
 * A merchant's trade-in program (parked for V2): which products it takes, the
 * condition grades a customer chooses from, and what each grade is worth: a
 * fixed amount, or a percentage of what the customer paid. Port of
 * TradeInProgram.
 */
import { Prisma, type TradeInProgram } from "@prisma/client";
import prisma from "../db.server";
import { addMonths } from "../lib/dates";
import type { Db } from "../lib/db-lock.server";
import { parameterize } from "../lib/inflections";
import { normalizeEligibility, validateEligibility } from "./product-eligibility.server";
import {
  assertValid,
  attributesOf,
  d,
  type DecimalInput,
  Errors,
  jsonArray,
  validateInclusion,
  validateNumber,
  validatePresence,
} from "./validation.server";

export const CREDIT_MODES = ["fixed", "percent"] as const;
export type CreditMode = (typeof CREDIT_MODES)[number];

// A type alias (not an interface) so it is assignable to Prisma JSON input.
export type Grade = {
  key: string;
  label: string;
  description: string;
  value: number;
};

export const DEFAULT_GRADES: readonly Grade[] = [
  { key: "excellent", label: "Excellent", description: "Hardly worn, no visible wear", value: 40 },
  { key: "good", label: "Good", description: "Light wear, fully intact", value: 25 },
  { key: "worn", label: "Worn", description: "Heavy wear or needs repair", value: 10 },
];

export interface TradeInProgramInput {
  shopId: number;
  name?: string;
  eligibility?: Prisma.JsonValue;
  creditMode?: string;
  grades?: unknown[];
  maxAgeMonths?: number | null;
  instructions?: string | null;
  position?: number;
  active?: boolean;
}

const DEFAULTS = { eligibility: { mode: "all" }, creditMode: "fixed", grades: [], position: 0, active: true };

export const programGrades = (program: Pick<TradeInProgram, "grades">) =>
  jsonArray(program.grades) as Grade[];

/** Rails before_validation: drop unlabelled grades, derive keys, numeric values. */
export function normalizeGrades(grades: unknown[]): Grade[] {
  return grades.flatMap((raw) => {
    const grade = (raw ?? {}) as Record<string, unknown>;
    const label = String(grade.label ?? "").trim();
    if (!label) return [];
    const key = String(grade.key ?? "").trim() ? String(grade.key) : parameterize(label, "_");
    return [
      { key, label, description: String(grade.description ?? "").trim(), value: d(grade.value).toNumber() },
    ];
  });
}

export function validateTradeInProgram(
  p: Omit<TradeInProgramInput, "grades" | "eligibility"> & {
    grades: Grade[];
    creditMode: string;
    eligibility?: Prisma.JsonValue;
  },
): Errors {
  const errors = new Errors();
  validatePresence(errors, "name", p.name);
  validateInclusion(errors, "creditMode", p.creditMode, CREDIT_MODES);
  validateNumber(errors, "maxAgeMonths", p.maxAgeMonths, {
    onlyInteger: true,
    greaterThan: 0,
    allowNull: true,
  });
  validateEligibility(errors, p.eligibility ?? DEFAULTS.eligibility);
  if (p.grades.length === 0) errors.add("grades", "need at least one condition");
  if (new Set(p.grades.map((g) => g.key)).size !== p.grades.length)
    errors.add("grades", "must have different names");
  if (p.grades.some((g) => g.value < 0)) errors.add("grades", "can't be worth less than nothing");
  if (p.creditMode === "percent" && p.grades.some((g) => g.value > 100))
    errors.add("grades", "can't be more than 100% of the price paid");
  return errors;
}

async function save(db: Db, attrs: TradeInProgramInput, id?: number): Promise<TradeInProgram> {
  const merged = { ...DEFAULTS, ...attrs };
  const data = {
    ...merged,
    eligibility: normalizeEligibility(merged.eligibility as Prisma.JsonValue),
    grades: normalizeGrades(merged.grades),
  };
  assertValid("TradeInProgram", validateTradeInProgram(data));
  const record = { ...data, name: data.name as string, eligibility: { ...data.eligibility } };
  return id
    ? db.tradeInProgram.update({ where: { id }, data: record })
    : db.tradeInProgram.create({ data: record });
}

export function createTradeInProgram(input: TradeInProgramInput, db: Db = prisma) {
  return save(db, input);
}

export async function updateTradeInProgram(
  id: number,
  patch: Partial<Omit<TradeInProgramInput, "shopId">>,
  db: Db = prisma,
) {
  const current = await db.tradeInProgram.findUniqueOrThrow({ where: { id } });
  const attrs = attributesOf(current);
  return save(db, { ...attrs, grades: jsonArray(attrs.grades), ...patch }, id);
}

export function findGrade(program: Pick<TradeInProgram, "grades">, key: string): Grade | null {
  return programGrades(program).find((g) => g.key === String(key)) ?? null;
}

/**
 * Credit for a grade. `paid` is what the customer paid for the item (needed
 * for percentage programs); `bonusPercent` comes from a Care plan perk.
 */
export function creditFor(
  program: Pick<TradeInProgram, "grades" | "creditMode">,
  key: string,
  { paid = null, bonusPercent = 0 }: { paid?: DecimalInput | null; bonusPercent?: DecimalInput } = {},
): Prisma.Decimal | null {
  const grade = findGrade(program, key);
  if (!grade) return null;
  if (program.creditMode === "percent" && (paid === null || paid === "")) return null;
  const base =
    program.creditMode === "fixed" ? d(grade.value) : d(paid).mul(d(grade.value)).div(100);
  return base.mul(d(bonusPercent).add(100)).div(100).toDecimalPlaces(2);
}

/** Too old to take? (`purchasedAt` null = unknown, allowed.) */
export function acceptsAge(
  program: Pick<TradeInProgram, "maxAgeMonths">,
  purchasedAt: Date | null,
  at = new Date(),
): boolean {
  if (program.maxAgeMonths === null || purchasedAt === null) return true;
  return purchasedAt >= addMonths(at, -program.maxAgeMonths);
}

export const ORDERED: Prisma.TradeInProgramOrderByWithRelationInput[] = [
  { position: "asc" },
  { id: "asc" },
];
