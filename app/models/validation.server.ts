/**
 * Validation for the model layer: the counterpart of ActiveModel errors.
 *
 * Each model module has a pure `validate<Model>(attrs)` that returns an
 * `Errors` (no database), plus, where Rails validated against the database
 * (uniqueness, same-shop checks), an async check inside its `create`/`update`
 * functions. Those throw `ValidationError` instead of saving, like `save!`.
 */
import { Prisma } from "@prisma/client";
import { humanize } from "../lib/inflections";

export type ErrorMap = Record<string, string[]>;

export class Errors {
  private readonly map: ErrorMap = {};

  /** `field` is the attribute's camelCase name, or "base". */
  add(field: string, message: string): this {
    (this.map[field] ??= []).push(message);
    return this;
  }

  get isEmpty(): boolean {
    return Object.keys(this.map).length === 0;
  }

  on(field: string): string[] {
    return this.map[field] ?? [];
  }

  merge(other: Errors): this {
    for (const [field, messages] of Object.entries(other.toJSON())) {
      for (const message of messages) this.add(field, message);
    }
    return this;
  }

  toJSON(): ErrorMap {
    return { ...this.map };
  }

  /** ["Name can't be blank", "This item already has …"] like Rails `full_messages`. */
  fullMessages(): string[] {
    return Object.entries(this.map).flatMap(([field, messages]) =>
      messages.map((message) =>
        field === "base"
          ? message
          : `${humanize(field.replace(/([A-Z])/g, "_$1").toLowerCase())} ${message}`,
      ),
    );
  }
}

export class ValidationError extends Error {
  constructor(
    readonly model: string,
    readonly errors: Errors,
  ) {
    super(`${model} is invalid: ${errors.fullMessages().join(", ")}`);
    this.name = "ValidationError";
  }
}

/** Throws ValidationError unless `errors` is empty (Rails `save!`). */
export function assertValid(model: string, errors: Errors): void {
  if (!errors.isEmpty) throw new ValidationError(model, errors);
}

export type DecimalInput = Prisma.Decimal | number | string;

/** Parses a number-ish value; null when it isn't a number (Rails numericality). */
export function toDecimal(value: unknown): Prisma.Decimal | null {
  if (value === null || value === undefined || value === "") return null;
  if (Prisma.Decimal.isDecimal(value)) return new Prisma.Decimal(value);
  if (typeof value !== "number" && typeof value !== "string") return null;
  try {
    const decimal = new Prisma.Decimal(typeof value === "string" ? value.trim() : value);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

/** Ruby `to_d`: like toDecimal, but blank or junk is 0. */
export function d(value: unknown): Prisma.Decimal {
  return toDecimal(value) ?? new Prisma.Decimal(0);
}

interface NumberRule {
  onlyInteger?: boolean;
  greaterThan?: number;
  greaterThanOrEqualTo?: number;
  lessThan?: number;
  lessThanOrEqualTo?: number;
  otherThan?: number;
  allowNull?: boolean;
}

/** Rails `validates :field, numericality: { … }`, with Rails' messages. */
export function validateNumber(
  errors: Errors,
  field: string,
  value: unknown,
  rule: NumberRule = {},
): void {
  if ((value === null || value === undefined) && rule.allowNull) return;
  const n = toDecimal(value);
  if (n === null) {
    errors.add(field, "is not a number");
    return;
  }
  if (rule.onlyInteger && !n.isInteger()) {
    errors.add(field, "must be an integer");
    return;
  }
  if (rule.greaterThan !== undefined && !n.gt(rule.greaterThan))
    errors.add(field, `must be greater than ${rule.greaterThan}`);
  if (rule.greaterThanOrEqualTo !== undefined && !n.gte(rule.greaterThanOrEqualTo))
    errors.add(field, `must be greater than or equal to ${rule.greaterThanOrEqualTo}`);
  if (rule.lessThan !== undefined && !n.lt(rule.lessThan))
    errors.add(field, `must be less than ${rule.lessThan}`);
  if (rule.lessThanOrEqualTo !== undefined && !n.lte(rule.lessThanOrEqualTo))
    errors.add(field, `must be less than or equal to ${rule.lessThanOrEqualTo}`);
  if (rule.otherThan !== undefined && n.eq(rule.otherThan))
    errors.add(field, `must be other than ${rule.otherThan}`);
}

export function validatePresence(errors: Errors, field: string, value: unknown): void {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    errors.add(field, "can't be blank");
  }
}

/** Rails enum `validate: true` / inclusion. */
export function validateInclusion(
  errors: Errors,
  field: string,
  value: unknown,
  allowed: readonly string[],
  { allowNull = false } = {},
): void {
  if ((value === null || value === undefined) && allowNull) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.add(field, "is not included in the list");
  }
}

export function validateMaxLength(
  errors: Errors,
  field: string,
  value: string | null | undefined,
  maximum: number,
): void {
  if (value && value.length > maximum) {
    errors.add(field, `is too long (maximum is ${maximum} characters)`);
  }
}

// URI::MailTo::EMAIL_REGEXP from Ruby's standard library.
const EMAIL_REGEXP =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** Rails `format: { with: URI::MailTo::EMAIL_REGEXP }, allow_blank: true`. */
export function validateEmail(
  errors: Errors,
  field: string,
  value: string | null | undefined,
): void {
  if (!value || value.trim() === "") return;
  if (!EMAIL_REGEXP.test(value)) errors.add(field, "is invalid");
}

/** Plain JSON object from a jsonb value (anything else → {}). */
export function jsonObject(value: Prisma.JsonValue | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** JSON array from a jsonb value (anything else → []). */
export function jsonArray(value: Prisma.JsonValue | undefined): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Escapes LIKE wildcards, for ILIKE searches (Rails `sanitize_sql_like`). */
export function likePattern(term: string): string {
  return `%${term.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Ids of rows whose text columns match `term` case-insensitively, with LIKE
 * wildcards in the term taken literally (Rails `search` scopes). Returns a
 * `where` fragment so it combines with other conditions.
 */
export async function searchWhere(
  db: { $queryRaw: Prisma.TransactionClient["$queryRaw"] },
  table: string,
  columns: string[],
  term: string,
): Promise<{ id: { in: number[] } }> {
  const pattern = likePattern(term);
  const conditions = Prisma.join(
    columns.map((column) => Prisma.sql`${Prisma.raw(`"${column}"`)} ILIKE ${pattern}`),
    " OR ",
  );
  const rows = await db.$queryRaw<{ id: number }[]>(
    Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE ${conditions}`,
  );
  return { id: { in: rows.map((row) => row.id) } };
}

/** A row's attributes without id and timestamps, to merge an update onto. */
export function attributesOf<T extends { id: number; createdAt: Date; updatedAt: Date }>(
  row: T,
): Omit<T, "id" | "createdAt" | "updatedAt"> {
  const attrs: Partial<T> = { ...row };
  delete attrs.id;
  delete attrs.createdAt;
  delete attrs.updatedAt;
  return attrs as Omit<T, "id" | "createdAt" | "updatedAt">;
}
