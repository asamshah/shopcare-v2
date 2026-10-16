/** Workshop inventory admin (Rails PartsController, PartVariantsController, PartImportsController). */
import { Prisma, type Part } from "@prisma/client";
import { plainNumber } from "../../lib/money";
import { OPTION_NAMES, partOptionNames } from "../../models/part.server";
import { bool, field, type Form, has, list, parse, zDecimal, zText } from "./form.server";

export const UNIT_LABELS: Record<string, string> = {
  each: "Each",
  pair: "Pair",
  metre: "Metre",
  ml: "Millilitre (ml)",
  g: "Gram (g)",
};

export interface PartValues {
  name: string;
  sku: string;
  notes: string;
  active: boolean;
  unit: string;
  packSize: string;
  costPerUnit: string;
  reorderLevel: string;
  reorderQuantity: string;
  optionNames: string[];
}

export const NEW_PART: PartValues = {
  name: "",
  sku: "",
  notes: "",
  active: true,
  unit: "each",
  packSize: "1",
  costPerUnit: "0",
  reorderLevel: "0",
  reorderQuantity: "0",
  optionNames: [],
};

export const partValues = (p: Part): PartValues => ({
  name: p.name,
  sku: p.sku ?? "",
  notes: p.notes ?? "",
  active: p.active,
  unit: p.unit,
  packSize: plainNumber(p.packSize),
  costPerUnit: plainNumber(p.costPerUnit),
  reorderLevel: plainNumber(p.reorderLevel),
  reorderQuantity: plainNumber(p.reorderQuantity),
  optionNames: partOptionNames(p),
});

export function readPart(form: Form, base: PartValues) {
  const pick = (name: string, fallback: string) => (has(form, name) ? field(form, name).trim() : fallback);
  const values: PartValues = {
    name: parse(zText(255), pick("name", base.name)),
    sku: parse(zText(255), pick("sku", base.sku)),
    notes: parse(zText(5000), pick("notes", base.notes)),
    active: has(form, "active") ? bool(form, "active") : base.active,
    unit: parse(zText(20), pick("unit", base.unit)),
    packSize: pick("pack_size", base.packSize),
    costPerUnit: pick("cost_per_unit", base.costPerUnit),
    reorderLevel: pick("reorder_level", base.reorderLevel),
    reorderQuantity: pick("reorder_quantity", base.reorderQuantity),
    optionNames: has(form, "option_names")
      ? list(form, "option_names").filter((o) => (OPTION_NAMES as readonly string[]).includes(o))
      : base.optionNames,
  };
  const num = (v: string) => parse(zDecimal, v) ?? undefined;
  const input = {
    name: values.name,
    sku: values.sku || null,
    notes: values.notes || null,
    active: values.active,
    unit: values.unit,
    packSize: num(values.packSize),
    costPerUnit: num(values.costPerUnit),
    reorderLevel: num(values.reorderLevel),
    reorderQuantity: num(values.reorderQuantity),
    optionNames: values.optionNames,
  };
  return { values, input };
}

/** A non-negative quantity typed into a stock field, or null when blank. */
export function quantity(raw: string): Prisma.Decimal | null {
  const value = parse(zDecimal, raw);
  return value === null ? null : new Prisma.Decimal(value);
}

/** A CSV download (Rails `send_data …, type: "text/csv"`). */
export function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const today = () => new Date().toISOString().slice(0, 10);

/** An ISO date param, or null (Rails `Date.iso8601` rescue nil). */
export function parseIsoDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}
