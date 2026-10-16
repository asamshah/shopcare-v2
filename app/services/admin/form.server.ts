/**
 * Reading admin form posts. Every action validates its input with zod before
 * touching the database: ids are positive ints, numbers are numbers, text is
 * bounded. Model validations (app/models) then give the merchant-facing
 * messages, as in Rails.
 *
 * Forms follow the Rails pattern of a hidden "0" before a checkbox, so a
 * repeated name is read as its LAST value (Rack's behaviour).
 */
import { z } from "zod";
import { castBoolean } from "../../lib/inflections";
import { badRequest } from "./context.server";

export type Form = FormData;

export async function readForm(request: Request): Promise<Form> {
  try {
    return await request.formData();
  } catch {
    badRequest("Expected a form post.");
  }
}

/** The last value submitted for `name` ("" when absent). Files are ignored. */
export function field(form: Form, name: string): string {
  const values = form.getAll(name).filter((v): v is string => typeof v === "string");
  return values.length ? values[values.length - 1] : "";
}

export const has = (form: Form, name: string) => form.has(name);

/** A hidden "0" + checkbox "1" pair. */
export const bool = (form: Form, name: string) => castBoolean(field(form, name));

/** Every non-file value for a repeated field, e.g. `option_names[]`. */
export function list(form: Form, name: string): string[] {
  return form.getAll(name).filter((v): v is string => typeof v === "string");
}

/** `prefix[key]` fields as an object, e.g. values[size] → { size }. */
export function nested(form: Form, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string" || !key.startsWith(`${prefix}[`) || !key.endsWith("]")) continue;
    const inner = key.slice(prefix.length + 1, -1);
    if (inner.includes("[")) continue;
    out[inner] = value;
  }
  return out;
}

/** Validates with zod; malformed input (not a merchant typo) is a 400. */
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) badRequest(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return result.data;
}

// --- Shared schemas -------------------------------------------------------------------

const MAX_INT = 2_147_483_647;

export const zId = z.coerce.number().int().positive().max(MAX_INT);

/** "" → null, else an id. */
export const zOptionalId = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(z.coerce.number().int().positive().max(MAX_INT).nullable());

export const zText = (max = 500) => z.string().trim().max(max);
export const zLongText = zText(10_000);

/** A decimal typed into a number/money field: "" → null; "12", "12.5", "-3". */
export const zDecimal = z
  .string()
  .trim()
  .transform((v) => v.replace(/^[£$€]/, ""))
  .refine((v) => v === "" || /^-?\d{1,12}(\.\d{1,6})?$/.test(v), "must be a number")
  .transform((v) => (v === "" ? null : v));

/** An integer typed into a number field: "" → null. */
export const zInt = z
  .string()
  .trim()
  .refine((v) => v === "" || /^-?\d{1,9}(\.0+)?$/.test(v), "must be a whole number")
  .transform((v) => (v === "" ? null : Math.trunc(Number(v))));

export const zIntent = <T extends [string, ...string[]]>(values: T) => z.enum(values);
