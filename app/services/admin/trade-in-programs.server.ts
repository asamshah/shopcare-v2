/** Trade-in programs admin (Rails TradeInProgramsController), behind the trade-in flag. */
import type { TradeInProgram } from "@prisma/client";
import prisma from "../../db.server";
import { plainNumber } from "../../lib/money";
import { eligibilityMode, eligibilityValue } from "../../models/product-eligibility.server";
import { programGrades } from "../../models/trade-in-program.server";
import { bool, field, type Form, has, parse, zInt, zText } from "./form.server";

export const GRADE_ROWS = 5;

export interface GradeRow {
  key: string;
  label: string;
  description: string;
  value: string;
}

export interface ProgramValues {
  name: string;
  creditMode: string;
  maxAgeMonths: string;
  instructions: string;
  active: boolean;
  grades: GradeRow[];
  eligibilityMode: string;
  eligibilityValue: string;
  position: string;
}

export const programValues = (p: Pick<TradeInProgram, "name" | "creditMode" | "maxAgeMonths" | "instructions" | "active" | "grades" | "eligibility" | "position">): ProgramValues => ({
  name: p.name,
  creditMode: p.creditMode,
  maxAgeMonths: p.maxAgeMonths === null ? "" : String(p.maxAgeMonths),
  instructions: p.instructions ?? "",
  active: p.active,
  grades: programGrades(p).map((g) => ({
    key: g.key,
    label: g.label,
    description: g.description ?? "",
    value: plainNumber(g.value),
  })),
  eligibilityMode: eligibilityMode(p.eligibility),
  eligibilityValue: eligibilityValue(p.eligibility),
  position: String(p.position),
});

/** The form's grade rows, padded with blanks so there are always some to fill in. */
export function gradeRows(grades: GradeRow[]): GradeRow[] {
  const blanks = Math.max(GRADE_ROWS - grades.length, 1);
  return [...grades, ...Array.from({ length: blanks }, () => ({ key: "", label: "", description: "", value: "" }))];
}

export function readProgram(form: Form, base: ProgramValues) {
  const pick = (name: string, fallback: string) => (has(form, name) ? field(form, name).trim() : fallback);
  const grades: GradeRow[] = [];
  for (let i = 0; i < 20; i++) {
    if (!has(form, `grades[${i}][label]`)) continue;
    grades.push({
      key: parse(zText(100), field(form, `grades[${i}][key]`)),
      label: parse(zText(255), field(form, `grades[${i}][label]`)),
      description: parse(zText(1000), field(form, `grades[${i}][description]`)),
      value: parse(zText(20), field(form, `grades[${i}][value]`)),
    });
  }
  const values: ProgramValues = {
    name: parse(zText(255), pick("name", base.name)),
    creditMode: parse(zText(20), pick("credit_mode", base.creditMode)),
    maxAgeMonths: pick("max_age_months", base.maxAgeMonths),
    instructions: parse(zText(5000), pick("instructions", base.instructions)),
    active: has(form, "active") ? bool(form, "active") : base.active,
    grades: grades.length || has(form, "grades[0][label]") ? grades : base.grades,
    eligibilityMode: parse(zText(20), pick("eligibility_mode", base.eligibilityMode)) || "all",
    eligibilityValue: parse(zText(255), pick("eligibility_value", base.eligibilityValue)),
    position: pick("position", base.position),
  };
  const maxAge = parse(zInt, values.maxAgeMonths);
  const position = parse(zInt, values.position);
  const input = {
    name: values.name,
    creditMode: values.creditMode,
    maxAgeMonths: maxAge,
    instructions: values.instructions || null,
    active: values.active,
    grades: values.grades.map((g) => ({ ...g, value: g.value === "" ? 0 : g.value })),
    eligibility: { mode: values.eligibilityMode, value: values.eligibilityValue },
    ...(position === null ? {} : { position }),
  };
  return { values, input };
}

export async function nextProgramPosition(shopId: number) {
  const last = await prisma.tradeInProgram.aggregate({ where: { shopId }, _max: { position: true } });
  return (last._max.position ?? -1) + 1;
}
