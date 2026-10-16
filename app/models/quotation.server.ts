/**
 * A repair quote. Port of Quotation.
 *
 *   draft → sent → paid
 *               ↘ declined / expired (staff can revise into a new draft)
 *
 * "Sent" means the Shopify draft order's invoice was emailed: the invoice is
 * the quote, and paying it accepts the quote. A £0 covered quote goes straight
 * from draft to paid. Any open quote is cancelled with its ticket.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma, type Cover, type Quotation } from "@prisma/client";
import prisma from "../db.server";
import { longDate } from "../lib/dates";
import { type Db, inTransaction, withRowLock } from "../lib/db-lock.server";
import { decrypt, encrypt } from "../lib/encryption.server";
import { formatAmount } from "../lib/money";
import {
  coverDiscountPercent,
  coverExcess,
  coverName,
  coverOutcomeLabel,
} from "./cover.server";
import { createQuotationLineItem, lineTotal } from "./quotation-line-item.server";
import { statutoryRightsNotice } from "./statutory-rights.server";
import {
  assertValid,
  d,
  Errors,
  validateInclusion,
  validateNumber,
} from "./validation.server";

export { CURRENCY_SYMBOLS } from "../lib/money";

export const QUOTATION_STATUSES = ["draft", "sent", "paid", "declined", "expired", "cancelled"] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];
/** The quote can still be cancelled with its ticket (not yet paid or closed). */
export const OPEN_STATUSES: readonly QuotationStatus[] = ["draft", "sent"];
/** Staff can start a new draft from these. */
export const REVISABLE_STATUSES: readonly QuotationStatus[] = ["sent", "declined", "expired"];
export const DECIDED_BY = ["customer", "staff", "system"] as const;

const TOKEN_CONTEXT = "Quotation.decisionToken";

export type QuotationWithCover = Quotation & { cover: Cover | null };

export function validateQuotation(
  q: Pick<Prisma.QuotationUncheckedCreateInput, "status" | "decidedBy" | "coverDiscountPercent">,
): Errors {
  const errors = new Errors();
  validateInclusion(errors, "status", q.status ?? "draft", QUOTATION_STATUSES);
  validateInclusion(errors, "decidedBy", q.decidedBy, DECIDED_BY, { allowNull: true });
  validateNumber(errors, "coverDiscountPercent", q.coverDiscountPercent ?? 0, {
    greaterThanOrEqualTo: 0,
    lessThanOrEqualTo: 100,
  });
  return errors;
}

export async function createQuotation(
  data: Prisma.QuotationUncheckedCreateInput,
  db: Db = prisma,
): Promise<Quotation> {
  assertValid("Quotation", validateQuotation(data));
  return db.quotation.create({ data });
}

export async function updateQuotation(
  id: number,
  data: Prisma.QuotationUncheckedUpdateInput,
  db: Db = prisma,
): Promise<Quotation> {
  const current = await db.quotation.findUniqueOrThrow({ where: { id } });
  assertValid(
    "Quotation",
    validateQuotation({ ...current, ...data } as Prisma.QuotationUncheckedCreateInput),
  );
  return db.quotation.update({ where: { id }, data });
}

/** Sum of the lines (qty × unit price − discount), before any cover. */
export async function linesTotal(quotationId: number, db: Db = prisma): Promise<Prisma.Decimal> {
  const [row] = await db.$queryRaw<{ total: Prisma.Decimal | null }[]>`
    SELECT SUM(unit_price * quantity - discount) AS total
    FROM quotation_line_items WHERE quotation_id = ${quotationId}`;
  return d(row?.total);
}

export function coverApplied(q: Pick<Quotation, "coverId" | "coverDiscountPercent">): boolean {
  return q.coverId !== null && d(q.coverDiscountPercent).gt(0);
}

/**
 * Recomputes each line's cover discount, the Care excess and the subtotal.
 * Warranty takes its percentage off every line; Care makes every line free
 * and adds its excess (if any) once for the repair.
 */
export function recalculateSubtotal(quotationId: number, db: Db = prisma): Promise<Quotation> {
  return inTransaction(db, async (tx) => {
    const quote = await tx.quotation.findUniqueOrThrow({
      where: { id: quotationId },
      include: { cover: true, lineItems: true },
    });
    const applied = coverApplied(quote) && quote.cover !== null;
    const percent = applied && quote.cover ? coverDiscountPercent(quote.cover) : new Prisma.Decimal(0);
    let totalCover = new Prisma.Decimal(0);
    for (const line of quote.lineItems) {
      const amount = lineTotal(line).mul(percent).div(100).toDecimalPlaces(2);
      if (!new Prisma.Decimal(line.coverDiscount).eq(amount)) {
        await tx.quotationLineItem.update({ where: { id: line.id }, data: { coverDiscount: amount } });
      }
      totalCover = totalCover.add(amount);
    }
    const excess =
      applied && quote.cover?.kind === "care" && quote.lineItems.length > 0
        ? coverExcess(quote.cover)
        : new Prisma.Decimal(0);
    const total = await linesTotal(quotationId, tx);
    return updateQuotation(
      quotationId,
      { coverDiscount: totalCover, coverExcess: excess, subtotal: total.sub(totalCover).add(excess) },
      tx,
    );
  });
}

/** Applies (or, with null, removes) a cover on this quote. */
export function applyCover(
  quotationId: number,
  cover: Cover | null,
  db: Db = prisma,
): Promise<Quotation> {
  return inTransaction(db, async (tx) => {
    await updateQuotation(
      quotationId,
      {
        coverId: cover?.id ?? null,
        coverDiscountPercent: cover ? coverDiscountPercent(cover) : 0,
      },
      tx,
    );
    return recalculateSubtotal(quotationId, tx);
  });
}

/**
 * What the cover does for the customer, e.g. "12-month warranty: 25% off
 * repairs. This cover is in addition to … your statutory rights." Null when no
 * cover applies.
 */
export function coverSummary(q: QuotationWithCover): string | null {
  if (!coverApplied(q) || !q.cover) return null;
  let text = `${coverName(q.cover)}: ${coverOutcomeLabel(q.cover)}.`;
  if (d(q.coverExcess).gt(0)) {
    text += ` Includes a ${formattedAmount(q, q.coverExcess)} excess.`;
  }
  return `${text} ${statutoryRightsNotice()}`;
}

/**
 * A £0 quote needs no payment: the draft order is completed straight away.
 * Normally that's because the item's cover makes it free. (Rails `warranty?`.)
 */
export function isWarrantyQuote(q: Pick<Quotation, "subtotal">): boolean {
  return d(q.subtotal).isZero();
}

export function isOpen(q: Pick<Quotation, "status">): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(q.status);
}

export function isDecisionOverdue(
  q: Pick<Quotation, "status" | "decisionExpiresAt">,
  now = new Date(),
): boolean {
  return q.status === "sent" && q.decisionExpiresAt !== null && q.decisionExpiresAt <= now;
}

/** Sent quotes whose validity has passed (Rails `scope :decision_overdue`). */
export function decisionOverdueWhere(now = new Date()): Prisma.QuotationWhereInput {
  return { status: "sent", decisionExpiresAt: { lt: now } };
}

/** e.g. "30 October 2026": the last day the customer can pay (accept). */
export function validUntil(q: Pick<Quotation, "decisionExpiresAt">): string | null {
  return q.decisionExpiresAt ? longDate(q.decisionExpiresAt) : null;
}

export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The review-link token, or null when the quote has none. */
export function decisionToken(q: Pick<Quotation, "decisionTokenCiphertext">): string | null {
  return q.decisionTokenCiphertext ? decrypt(q.decisionTokenCiphertext, TOKEN_CONTEXT) : null;
}

/** Starts a fresh link to the quote's review page; returns the token for the URL. */
export async function issueDecisionToken(
  quotationId: number,
  expiresAt: Date,
  db: Db = prisma,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await updateQuotation(
    quotationId,
    {
      decisionTokenCiphertext: encrypt(token, TOKEN_CONTEXT),
      decisionTokenDigest: tokenDigest(token),
      decisionExpiresAt: expiresAt,
    },
    db,
  );
  return token;
}

/**
 * Cancelled with its ticket, or superseded by a revision: the review link
 * stops working. (Callers delete the Shopify draft order.)
 */
export function cancelQuotation(quotationId: number, db: Db = prisma): Promise<Quotation> {
  return updateQuotation(
    quotationId,
    { status: "cancelled", decisionTokenCiphertext: null, decisionTokenDigest: null },
    db,
  );
}

/**
 * The quote a decision token belongs to, within one shop. The digest lookup
 * finds the row; the token itself is then compared in constant time.
 */
export async function findByDecisionToken(
  shopId: number,
  token: string | null | undefined,
  db: Db = prisma,
): Promise<Quotation | null> {
  if (!token || !token.trim() || token.length > 100) return null;
  const quotation = await db.quotation.findFirst({
    where: { decisionTokenDigest: tokenDigest(token), repairTicket: { shopId } },
  });
  const stored = quotation ? decisionToken(quotation) : null;
  if (!quotation || !stored) return null;
  const a = Buffer.from(stored);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b) ? quotation : null;
}

const COPIED_LINE_FIELDS = [
  "kind",
  "title",
  "quantity",
  "unitPrice",
  "discount",
  "shopifyProductId",
  "shopifyVariantId",
] as const;

/**
 * A new draft with the same lines and cover, for staff to edit and send again.
 * A quote still awaiting the customer is cancelled, so only the revision can
 * be paid. Returns null if this quote can't be revised. Runs under a row lock
 * on the quote, so two staff can't revise it twice.
 */
export function reviseQuotation(quotationId: number, db: Db = prisma): Promise<Quotation | null> {
  return inTransaction(db, async (tx) => {
    await withRowLock(tx, "quotations", quotationId);
    const quote = await tx.quotation.findUniqueOrThrow({ where: { id: quotationId } });
    if (!(REVISABLE_STATUSES as readonly string[]).includes(quote.status)) return null;

    if (quote.status === "sent") await cancelQuotation(quote.id, tx);
    const copy = await createQuotation(
      {
        repairTicketId: quote.repairTicketId,
        currency: quote.currency,
        coverId: quote.coverId,
        coverDiscountPercent: quote.coverDiscountPercent,
        revisedFromId: quote.id,
      },
      tx,
    );
    const lines = await tx.quotationLineItem.findMany({
      where: { quotationId: quote.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const line of lines) {
      const fields = Object.fromEntries(COPIED_LINE_FIELDS.map((f) => [f, line[f]]));
      await createQuotationLineItem({ ...fields, quotationId: copy.id }, tx);
    }
    return recalculateSubtotal(copy.id, tx);
  });
}

/** e.g. "£12.50", or "12.50 CAD" when there's no symbol for the currency. */
export function formattedAmount(
  q: Pick<Quotation, "currency">,
  value: Prisma.Decimal | number | string,
): string {
  return formatAmount(value, q.currency);
}

export function formattedSubtotal(q: Pick<Quotation, "currency" | "subtotal">): string {
  return formattedAmount(q, q.subtotal);
}
