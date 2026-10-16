/**
 * The Shopify draft order behind a quotation (Rails Repairs::QuoteDraftOrder).
 *
 * `quoteDraftOrderAttributes` is the draft order's content;
 * `ensureQuoteDraftOrder` (Rails `id!`) returns the quote's draft order id,
 * creating it the first time or bringing a reused one (left by an attempt
 * that failed part-way) up to date; `deleteQuoteDraftOrder` (Rails `delete`)
 * deletes it so its invoice can't be paid. Callers hold the quotation's row
 * lock and pass its transaction as `db`.
 *
 * Every line is priced from the quote. A "repair" line backed by a real
 * Shopify variant links to the product and carries the quote's unit price as
 * `priceOverride` (Rails sent `price`, which REST ignored on variant lines, so
 * the invoice could differ from the quote). Other lines are custom-titled. A
 * line's own discount and its share of the cover discount go to Shopify as
 * one fixed discount; a Care plan's excess is one extra line.
 */
import { Prisma, type QuotationLineItem } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { coverName } from "../../models/cover.server";
import { repairOrderTag } from "../../models/shop.server";
import {
  createDraftOrder,
  deleteDraftOrder,
  updateDraftOrder,
  type DraftOrderAttributes,
  type DraftOrderLine,
} from "../../shopify/draft-orders.server";
import { errorSummary, type AdminGraphqlClient } from "../../shopify/graphql.server";

type Line = Pick<
  QuotationLineItem,
  | "title"
  | "quantity"
  | "unitPrice"
  | "discount"
  | "coverDiscount"
  | "shopifyVariantId"
>;

export interface QuoteDraftOrderInput {
  quotation: {
    id: number;
    currency: string | null;
    coverExcess: Prisma.Decimal | number | string;
  };
  lineItems: Line[];
  ticket: { id: number; customerEmail: string | null };
  /** The cover applied to the quote (named on discounts and the excess). */
  coverName?: string | null;
  /** Shop.repairOrderTag(). */
  orderTag: string;
  /** The shop's currency, when the quote has none recorded. */
  shopCurrency: string;
}

const money = (amount: Prisma.Decimal | number | string) =>
  new Prisma.Decimal(amount).toFixed(2);

function discountDescription(line: Line, coverName: string | null | undefined) {
  if (!new Prisma.Decimal(line.coverDiscount).gt(0)) return "Discount";
  const name = coverName ?? "Cover";
  return new Prisma.Decimal(line.discount).gt(0) ? `Discount + ${name}` : name;
}

export function quoteDraftOrderLine(
  line: Line,
  coverName?: string | null,
): DraftOrderLine {
  const discount = new Prisma.Decimal(line.discount).add(line.coverDiscount);
  const appliedDiscount = discount.gt(0)
    ? {
        description: discountDescription(line, coverName),
        valueType: "FIXED_AMOUNT" as const,
        value: money(discount),
      }
    : undefined;
  const variantId = line.shopifyVariantId?.trim();
  return variantId
    ? {
        variantId,
        quantity: line.quantity,
        priceOverride: money(line.unitPrice),
        ...(appliedDiscount ? { appliedDiscount } : {}),
      }
    : {
        title: line.title,
        quantity: line.quantity,
        price: money(line.unitPrice),
        requiresShipping: false,
        taxable: true,
        ...(appliedDiscount ? { appliedDiscount } : {}),
      };
}

export function quoteDraftOrderAttributes(
  input: QuoteDraftOrderInput,
): DraftOrderAttributes {
  const { quotation, ticket, coverName } = input;
  const lines = input.lineItems.map((line) =>
    quoteDraftOrderLine(line, coverName),
  );
  if (new Prisma.Decimal(quotation.coverExcess).gt(0)) {
    lines.push({
      title: `${coverName ?? "Cover"}: excess`,
      quantity: 1,
      price: money(quotation.coverExcess),
      requiresShipping: false,
      taxable: true,
    });
  }
  return {
    lineItems: lines,
    currencyCode: quotation.currency || input.shopCurrency,
    email: ticket.customerEmail,
    tags: input.orderTag,
    note: `Repair ticket #${ticket.id}`,
    customAttributes: [
      { key: "repair_quotation_id", value: String(quotation.id) },
      { key: "repair_ticket_id", value: String(ticket.id) },
    ],
    useCustomerDefaultAddress: false,
  };
}

/**
 * The quotation's draft order id, created the first time. A draft order
 * already recorded on the quote is updated to match the quote as it is now.
 * `shopCurrency` is asked only when the quote has no currency recorded.
 */
export async function ensureQuoteDraftOrder(
  quotationId: number,
  client: AdminGraphqlClient,
  {
    db = prisma,
    shopCurrency,
  }: { db?: Db; shopCurrency: () => Promise<string> },
): Promise<string> {
  const quotation = await db.quotation.findUniqueOrThrow({
    where: { id: quotationId },
    include: {
      cover: true,
      lineItems: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      repairTicket: { include: { shop: true } },
    },
  });
  const ticket = quotation.repairTicket;
  const attributes = quoteDraftOrderAttributes({
    quotation,
    lineItems: quotation.lineItems,
    ticket,
    coverName: quotation.cover ? coverName(quotation.cover) : null,
    orderTag: repairOrderTag(ticket.shop),
    shopCurrency: quotation.currency ?? (await shopCurrency()),
  });

  if (quotation.shopifyDraftOrderId) {
    const draft = await updateDraftOrder(
      client,
      quotation.shopifyDraftOrderId,
      attributes,
    );
    if (draft.invoiceUrl && draft.invoiceUrl !== quotation.shopifyDraftOrderUrl) {
      await db.quotation.update({
        where: { id: quotationId },
        data: { shopifyDraftOrderUrl: draft.invoiceUrl },
      });
    }
    return quotation.shopifyDraftOrderId;
  }

  const draft = await createDraftOrder(client, attributes);
  await db.quotation.update({
    where: { id: quotationId },
    data: { shopifyDraftOrderId: draft.id, shopifyDraftOrderUrl: draft.invoiceUrl },
  });
  return draft.id;
}

/**
 * Deletes the quote's draft order, so its invoice link stops working (a
 * declined, expired, revised or cancelled quote), and forgets it, so sending
 * again creates a new one. Returns a note for the ticket's activity log;
 * a Shopify failure is reported in the note, never thrown.
 */
export async function deleteQuoteDraftOrder(
  quotationId: number,
  client: AdminGraphqlClient,
  {
    db = prisma,
    logger = console,
  }: { db?: Db; logger?: Pick<Console, "error"> } = {},
): Promise<string> {
  const quotation = await db.quotation.findUniqueOrThrow({
    where: { id: quotationId },
  });
  if (!quotation.shopifyDraftOrderId) return "";
  try {
    await deleteDraftOrder(client, quotation.shopifyDraftOrderId);
    await db.quotation.update({
      where: { id: quotationId },
      data: { shopifyDraftOrderId: null, shopifyDraftOrderUrl: null },
    });
    return " Shopify draft order deleted, so its invoice can't be paid.";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      `[repairs/quote-draft-order] quotation=${quotationId} ${errorSummary(error)}`,
    );
    return ` Couldn't delete the Shopify draft order (${message}); delete it in Shopify so the customer can't pay.`;
  }
}
