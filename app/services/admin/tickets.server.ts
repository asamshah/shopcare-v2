/**
 * The repair tickets workbench (Rails TicketsController, QuotationsController,
 * QuotationLineItemsController, TicketPartsController): the list, the detail
 * page's data, and every action on a ticket. Money and state changes on
 * quotes go through the w2-backend contract services (app/services/quotes/*,
 * changeTicketStatus); this module only does admin-side edits.
 */
import { Prisma, type Shop } from "@prisma/client";
import prisma from "../../db.server";
import { signedUrl } from "../../lib/storage.server";
import { decimal, formatMoney } from "../../lib/format.server";
import {
  formatDate,
  formatDateTime,
  quotationStatusTone,
  registrationTone,
  statusLabel,
  ticketStatusTone,
  type Tone,
} from "../../lib/format";
import { coverDiscountPercent, coveredFaults, coverName, coverOutcomeLabel } from "../../models/cover.server";
import { activeCover, itemLabel, type ItemWithCovers, COVERS_ORDER } from "../../models/item.server";
import { partOptionNames, quantityLabel, varies, ORDERED as PARTS_ORDERED } from "../../models/part.server";
import { variantLabel } from "../../models/part-variant.server";
import {
  applyCover,
  coverApplied,
  createQuotation,
  decisionToken,
  isDecisionOverdue,
  recalculateSubtotal,
  REVISABLE_STATUSES,
} from "../../models/quotation.server";
import { createQuotationLineItem, lineTotal } from "../../models/quotation-line-item.server";
import {
  ACTIVITIES_ORDER,
  currentQuotation,
  linkItem,
  RECENT_ORDER,
  REPAIR_TICKET_STATUSES,
  repairTicketSearchWhere,
} from "../../models/repair-ticket.server";
import {
  completeWorkshopAddress,
  partsEnabled,
  proxyUrl,
  settingsOf,
  workshopAddressLines,
} from "../../models/shop.server";
import { createTicketActivity } from "../../models/ticket-activity.server";
import { createTicketPart, isConsumed, ticketPartCost, validateTicketPart } from "../../models/ticket-part.server";
import { assertValid, d, jsonObject, ValidationError } from "../../models/validation.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import { fetchRepairVariant, listRepairVariants } from "../../shopify/repair-products.server";
import { planTicketParts } from "../parts/planner.server";
import { declineQuote, expireQuote } from "../quotes/decision.server";
import { resendInvoice } from "../quotes/resend.server";
import { reviseQuote } from "../quotes/revise.server";
import { sendQuote } from "../quotes/send.server";
import { changeTicketStatus, markItemReceived } from "../repairs/ticket-status.server";
import { RETURNABLE_STATUSES, returnRepairedItem } from "../repairs/return-item.server";
import type { Tracking } from "../../shopify/fulfillments.server";
import { repairProductSettings } from "../repairs/service-import.server";
import { orNotFound, requireParts } from "./context.server";
import type { Flash } from "./flash.server";

export const PER_PAGE = 25;

export const shopCurrency = (shop: Pick<Shop, "settings">) => {
  const currency = settingsOf(shop).currency;
  return typeof currency === "string" && currency.trim() ? currency.trim() : "GBP";
};

const isStatus = (value: string) => (REPAIR_TICKET_STATUSES as readonly string[]).includes(value);

// --- List -----------------------------------------------------------------------

export async function ticketList(
  shop: Shop,
  { status, q, page }: { status: string | null; q: string | null; page: number },
) {
  const where: Prisma.RepairTicketWhereInput = { shopId: shop.id };
  const statusFilter = status && isStatus(status) ? status : null;
  if (statusFilter) where.status = statusFilter;
  if (q?.trim()) Object.assign(where, { AND: [await repairTicketSearchWhere(q.trim())] });

  // Fetch one extra row to know whether a next page exists, without a COUNT.
  const rows = await prisma.repairTicket.findMany({
    where,
    orderBy: RECENT_ORDER,
    skip: (page - 1) * PER_PAGE,
    take: PER_PAGE + 1,
    include: { quotations: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } },
  });
  const counts = await prisma.repairTicket.groupBy({
    by: ["status"],
    where: { shopId: shop.id },
    _count: { _all: true },
  });
  const countByStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));

  return {
    statusFilter,
    query: q ?? "",
    page,
    hasNextPage: rows.length > PER_PAGE,
    statuses: REPAIR_TICKET_STATUSES.map((s) => ({
      status: s,
      label: statusLabel(s),
      tone: ticketStatusTone(s),
      count: countByStatus[s] ?? 0,
    })),
    tickets: rows.slice(0, PER_PAGE).map((ticket) => {
      const quote = ticket.quotations[0];
      return {
        id: ticket.id,
        customer: ticket.customerName?.trim() || ticket.customerEmail || "",
        product: ticket.productTitle ?? "",
        status: statusLabel(ticket.status),
        tone: ticketStatusTone(ticket.status),
        inWarranty: ticket.inWarranty,
        quote: quote ? formatMoney(quote.subtotal, quote.currency) : "—",
        date: formatDate(ticket.createdAt),
      };
    }),
  };
}

// --- Detail ---------------------------------------------------------------------

export interface TicketDeps {
  listRepairVariants: typeof listRepairVariants;
  fetchRepairVariant: typeof fetchRepairVariant;
}

export const ticketDeps: TicketDeps = { listRepairVariants, fetchRepairVariant };

export async function findTicket(shop: Shop, id: number) {
  return orNotFound(await prisma.repairTicket.findFirst({ where: { id, shopId: shop.id } }));
}

/** Items that could be this ticket's: same customer id or email. */
async function candidateItems(shopId: number, customerId: string | null, email: string | null) {
  const or: Prisma.ItemWhereInput[] = [];
  if (customerId?.trim()) or.push({ shopifyCustomerId: customerId });
  if (email?.trim()) or.push({ customerEmail: { equals: email, mode: "insensitive" } });
  if (!or.length) return [];
  return prisma.item.findMany({
    where: { shopId, status: "active", OR: or },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    include: { covers: { orderBy: COVERS_ORDER } },
  });
}

export async function ticketDetail(shop: Shop, admin: AdminGraphqlClient, id: number, now = new Date()) {
  let ticket = await findTicket(shop, id);
  let quotation = await currentQuotation(ticket.id);
  // Don't wait for the daily job to show an unanswered quote as expired.
  if (quotation && isDecisionOverdue(quotation, now)) {
    await expireQuote({ shopId: shop.id, quotationId: quotation.id });
    ticket = await findTicket(shop, id);
    quotation = await currentQuotation(ticket.id);
  }
  const currency = quotation?.currency ?? shopCurrency(shop);
  const [lineItems, activities, images, item, cover] = await Promise.all([
    quotation
      ? prisma.quotationLineItem.findMany({
          where: { quotationId: quotation.id },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : [],
    prisma.ticketActivity.findMany({ where: { repairTicketId: ticket.id }, orderBy: [ACTIVITIES_ORDER, { id: "desc" }] }),
    prisma.ticketImage.findMany({ where: { repairTicketId: ticket.id }, orderBy: { id: "asc" } }),
    ticket.itemId
      ? prisma.item.findFirst({ where: { id: ticket.itemId, shopId: shop.id }, include: { registration: true } })
      : null,
    ticket.coverId ? prisma.cover.findUnique({ where: { id: ticket.coverId } }) : null,
  ]);
  const quoteCover = quotation?.coverId ? await prisma.cover.findUnique({ where: { id: quotation.coverId } }) : null;
  const candidates = item ? [] : await candidateItems(shop.id, ticket.shopifyCustomerId, ticket.customerEmail);
  const quoteOpen = !quotation || quotation.status === "draft";
  const repairVariants = quoteOpen
    ? await ticketDeps.listRepairVariants(admin, repairProductSettings(shop), { shopKey: shop.shopifyDomain })
    : [];

  const withParts = partsEnabled(shop);
  const ticketParts = withParts
    ? await prisma.ticketPart.findMany({
        where: { repairTicketId: ticket.id },
        orderBy: { id: "asc" },
        include: { part: { include: { variants: { orderBy: { id: "asc" } } } }, partVariant: true },
      })
    : [];
  const parts = withParts
    ? await prisma.part.findMany({ where: { shopId: shop.id, active: true }, orderBy: PARTS_ORDERED })
    : [];

  const token = quotation ? decisionToken(quotation) : null;
  const costs = jsonObject(ticket.costs);
  const workshop = completeWorkshopAddress(shop);
  const open = !["completed", "cancelled", "rejected"].includes(ticket.status);
  const address = jsonObject(ticket.customerAddress);
  const addressLine = ["address1", "city", "zip", "country"]
    .map((k) => String(address[k] ?? "").trim())
    .filter(Boolean)
    .join(", ");

  return {
    ticket: {
      id: ticket.id,
      status: ticket.status,
      statusLabel: statusLabel(ticket.status),
      tone: ticketStatusTone(ticket.status),
      completed: ticket.status === "completed",
      inWarranty: ticket.inWarranty,
      coverName: cover ? coverName(cover) : null,
      customerName: ticket.customerName ?? "",
      customerEmail: ticket.customerEmail,
      customerPhone: ticket.customerPhone,
      address: addressLine || null,
      productTitle: ticket.productTitle ?? "",
      variantTitle: ticket.variantTitle,
      orderNumber: ticket.orderNumber,
      orderDate: ticket.orderDate ? formatDate(ticket.orderDate) : null,
      noOrderHistory: ticket.noOrderHistory,
      description: ticket.description,
    },
    statuses: REPAIR_TICKET_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })),
    postage: {
      awaiting: ticket.status === "awaiting_item",
      receivedAt: ticket.itemReceivedAt ? formatDateTime(ticket.itemReceivedAt) : null,
      /** One line, or null until Settings → Repairs has a complete workshop address. */
      workshopAddress: workshop ? workshopAddressLines(workshop).join(", ") : null,
      canMarkReceived: open && !ticket.itemReceivedAt,
      canDownload: open && workshop !== null,
      /** "Mark returned": fulfils the paid repair order with tracking (Shopify's shipping confirmation). */
      canReturn:
        (RETURNABLE_STATUSES as readonly string[]).includes(ticket.status) &&
        quotation?.status === "paid" &&
        Boolean(quotation.shopifyOrderId),
    },
    quotation: quotation
      ? {
          status: quotation.status,
          statusLabel: statusLabel(quotation.status),
          tone: quotationStatusTone(quotation.status) as Tone,
          draft: quotation.status === "draft",
          draftOrderUrl: quotation.shopifyDraftOrderUrl,
          coverApplied: coverApplied(quotation),
          coverLabel: coverApplied(quotation)
            ? `${quoteCover ? coverName(quoteCover) : "Cover"}${
                quoteCover?.kind === "care" ? "" : ` (${decimal(quotation.coverDiscountPercent)}% off)`
              }`
            : null,
          coverDiscount: formatMoney(quotation.coverDiscount, currency),
          coverExcess: d(quotation.coverExcess).gt(0) ? formatMoney(quotation.coverExcess, currency) : null,
          subtotal: formatMoney(quotation.subtotal, currency),
          decision:
            quotation.sentAt && quotation.status !== "draft"
              ? {
                  sentAt: formatDateTime(quotation.sentAt),
                  validUntil: quotation.decisionExpiresAt ? formatDate(quotation.decisionExpiresAt) : null,
                  stillValid: quotation.status === "sent",
                  decided: quotation.decidedAt
                    ? `${{ declined: "Declined", expired: "Expired" }[quotation.status] ?? "Paid (accepted)"} ${formatDateTime(quotation.decidedAt)}`
                    : null,
                  reason: quotation.decisionReason,
                  reviewUrl: quotation.status === "sent" && token ? proxyUrl(shop, `quotes/${token}`) : null,
                  canResend: ["sent", "expired"].includes(quotation.status),
                  canRevise: (REVISABLE_STATUSES as readonly string[]).includes(quotation.status),
                  canDecline: quotation.status === "sent",
                }
              : null,
        }
      : null,
    lineItems: lineItems.map((line) => ({
      id: line.id,
      title: line.title,
      kind: line.kind,
      quantity: line.quantity,
      unitPrice: formatMoney(line.unitPrice, currency),
      discount: formatMoney(line.discount, currency),
      total: formatMoney(lineTotal(line), currency),
    })),
    canEditQuote: quoteOpen,
    ticketCoverName: cover ? coverName(cover) : null,
    repairVariants: repairVariants.map((v) => ({
      id: v.variantId,
      label: `${v.label} · ${formatMoney(v.price, quotation?.currency ?? null)}`,
    })),
    partsEnabled: withParts,
    ticketParts: ticketParts.map((tp) => ({
      id: tp.id,
      partId: tp.partId,
      partName: tp.part.name,
      consumed: isConsumed(tp),
      varies: varies(tp.part),
      variantId: tp.partVariantId,
      variantLabel: tp.partVariant ? variantLabel(tp.partVariant, tp.part) : null,
      variants: tp.part.variants.map((v) => ({
        id: v.id,
        label: `${variantLabel(v, tp.part)} (${decimal(v.onHand)} in stock)`,
      })),
      quantity: quantityLabel(tp.part, tp.quantity),
      cost: formatMoney(ticketPartCost(tp, tp.part), currency),
    })),
    parts: parts.map((p) => ({ id: p.id, label: `${p.name} · ${p.unit}` })),
    activities: activities.map((a) => ({
      id: a.id,
      type: statusLabel(a.activityType),
      when: formatDateTime(a.createdAt),
      author: a.author,
      body: a.body,
    })),
    images: images.map((image) => ({
      id: image.id,
      src: image.storageKey ? signedUrl(image.storageKey) : image.url ?? "",
      alt: image.storageKey ? image.filename ?? "Repair photo" : "Repair photo",
    })),
    costs: Object.keys(costs).length
      ? {
          price: formatMoney(String(costs.price ?? 0), String(costs.currency ?? "") || null),
          parts: formatMoney(String(costs.parts ?? 0), String(costs.currency ?? "") || null),
          labour: formatMoney(String(costs.labour ?? 0), String(costs.currency ?? "") || null),
          labourMinutes: String(costs.labour_minutes ?? 0),
          margin: formatMoney(String(costs.margin ?? 0), String(costs.currency ?? "") || null),
        }
      : null,
    item: item
      ? {
          id: item.id,
          label: itemLabel(item),
          registration:
            item.registration && item.registration.status !== "verified"
              ? { status: item.registration.status, tone: registrationTone(item.registration.status) }
              : null,
        }
      : null,
    cover: cover
      ? {
          name: coverName(cover),
          outcome: coverOutcomeLabel(cover),
          until: formatDate(cover.endsAt),
          faults: coveredFaults(cover),
        }
      : null,
    itemCandidates: candidates.map((c) => ({
      id: c.id,
      label: `${itemLabel(c)} · ${c.orderName?.trim() || "registered"}${activeCover(c, now) ? " · covered" : ""}`,
    })),
  };
}

// --- Actions ----------------------------------------------------------------------

type Outcome = Flash;

const statusText = (status: string) => status.replace(/_/g, " ");

export async function updateStatus(shop: Shop, ticketId: number, status: string): Promise<Outcome> {
  const ticket = await findTicket(shop, ticketId);
  if (!isStatus(status)) return { alert: "Unknown status." };
  if (status === ticket.status) return {};
  const result = await changeTicketStatus({ shopId: shop.id, ticketId: ticket.id, to: status, actor: "staff" });
  if (!result.ok) return { alert: result.error };
  return { notice: result.message || `Status updated to ${statusText(status)}.` };
}

export async function addNote(shop: Shop, ticketId: number, body: string): Promise<Outcome> {
  const ticket = await findTicket(shop, ticketId);
  const text = body.trim();
  if (!text) return { alert: "Note can't be blank." };
  await createTicketActivity({ repairTicketId: ticket.id, activityType: "note", author: "staff", body: text });
  return { notice: "Note added." };
}

/** Link the ticket to one of the shop's items (or unlink); its cover then sets the repair price. */
export async function linkTicketItem(shop: Shop, ticketId: number, itemId: number | null): Promise<Outcome> {
  const ticket = await findTicket(shop, ticketId);
  const item: ItemWithCovers | null = itemId
    ? orNotFound(
        await prisma.item.findFirst({
          where: { id: itemId, shopId: shop.id },
          include: { covers: { orderBy: COVERS_ORDER } },
        }),
      )
    : null;
  const attrs = linkItem(item);
  await prisma.$transaction(async (tx) => {
    await tx.repairTicket.update({ where: { id: ticket.id }, data: attrs });
    const cover = attrs.coverId ? await tx.cover.findUnique({ where: { id: attrs.coverId } }) : null;
    const quotation = await currentQuotation(ticket.id, tx);
    if (quotation?.status === "draft") await applyCover(quotation.id, cover, tx);
    let body = item ? `Linked to item #${item.id} (${itemLabel(item)}).` : "Unlinked from its item.";
    if (cover) body += ` ${coverName(cover)} applies.`;
    await createTicketActivity({ repairTicketId: ticket.id, activityType: "note", author: "staff", body }, tx);
  });
  return { notice: item ? "Ticket linked to item." : "Ticket unlinked." };
}

export interface LineInput {
  kind: "repair" | "extra";
  variantId: string | null;
  title: string;
  quantity: number;
  unitPrice: string | null;
  discount: string | null;
}

/** The open (draft) quote, started if there's none yet; null once the latest was sent. */
async function draftQuotation(shop: Shop, ticket: { id: number; coverId: number | null }) {
  const latest = await currentQuotation(ticket.id);
  if (latest) return latest.status === "draft" ? latest : null;
  const cover = ticket.coverId ? await prisma.cover.findUnique({ where: { id: ticket.coverId } }) : null;
  return createQuotation({
    repairTicketId: ticket.id,
    currency: shopCurrency(shop),
    coverId: cover?.id ?? null,
    coverDiscountPercent: cover ? coverDiscountPercent(cover) : 0,
  });
}

export async function addLineItem(
  shop: Shop,
  admin: AdminGraphqlClient,
  ticketId: number,
  input: LineInput,
): Promise<Outcome> {
  const ticket = await findTicket(shop, ticketId);
  const quotation = await draftQuotation(shop, ticket);
  if (!quotation) return { alert: "This quote has already been sent." };

  let line;
  if (input.kind === "repair" && input.variantId) {
    // Title and price come from Shopify, not the form.
    const variant = await ticketDeps.fetchRepairVariant(admin, input.variantId);
    if (!variant) return { alert: "That repair product couldn't be found." };
    line = {
      kind: "repair",
      title: variant.label,
      quantity: input.quantity,
      unitPrice: variant.price,
      shopifyProductId: variant.productId,
      shopifyVariantId: variant.variantId,
    };
  } else {
    line = {
      kind: "extra",
      title: input.title,
      quantity: input.quantity,
      unitPrice: input.unitPrice ?? 0,
      discount: input.discount ?? 0,
    };
  }
  try {
    await createQuotationLineItem({ ...line, quotationId: quotation.id });
  } catch (error) {
    if (error instanceof ValidationError) return { alert: toSentenceMessages(error) };
    throw error;
  }
  await recalculateSubtotal(quotation.id);
  return { notice: "Line item added." };
}

const toSentenceMessages = (error: ValidationError) => {
  const messages = error.errors.fullMessages();
  return messages.length <= 1
    ? messages.join("")
    : `${messages.slice(0, -1).join(", ")} and ${messages[messages.length - 1]}`;
};

export async function removeLineItem(shop: Shop, ticketId: number, lineId: number): Promise<Outcome> {
  const ticket = await findTicket(shop, ticketId);
  const quotation = await currentQuotation(ticket.id);
  const line =
    quotation?.status === "draft"
      ? await prisma.quotationLineItem.findFirst({ where: { id: lineId, quotationId: quotation.id } })
      : null;
  if (!quotation || !line) return { alert: "Line item not found." };
  await prisma.quotationLineItem.delete({ where: { id: line.id } });
  await recalculateSubtotal(quotation.id);
  return { notice: "Line item removed." };
}

export async function sendTicketQuote(shop: Shop, ticketId: number): Promise<Outcome> {
  const ticket = await findTicket(shop, ticketId);
  const quotation = await currentQuotation(ticket.id);
  const lines = quotation ? await prisma.quotationLineItem.count({ where: { quotationId: quotation.id } }) : 0;
  if (!quotation || lines === 0) return { alert: "Add at least one line item before sending." };
  const result = await sendQuote({ shopId: shop.id, quotationId: quotation.id, actor: "staff" });
  if (!result.ok) return { alert: result.error };
  return {
    notice: result.warranty
      ? `Warranty quote completed — ticket moved to ${statusText(result.ticketStatus ?? "in_repair")}.`
      : "Quote sent: Shopify emailed the customer its invoice.",
  };
}

async function requireQuotation(shop: Shop, ticketId: number) {
  const ticket = await findTicket(shop, ticketId);
  return currentQuotation(ticket.id);
}

export async function resendTicketInvoice(shop: Shop, ticketId: number): Promise<Outcome> {
  const quotation = await requireQuotation(shop, ticketId);
  if (!quotation) return { alert: "There's no quote on this ticket." };
  const result = await resendInvoice({ shopId: shop.id, quotationId: quotation.id, actor: "staff" });
  return result.ok ? { notice: "Invoice re-sent to the customer." } : { alert: result.error };
}

export async function reviseTicketQuote(shop: Shop, ticketId: number): Promise<Outcome> {
  const quotation = await requireQuotation(shop, ticketId);
  if (!quotation) return { alert: "There's no quote on this ticket." };
  const result = await reviseQuote({ shopId: shop.id, quotationId: quotation.id, actor: "staff" });
  return result.ok ? { notice: "New draft quote started from the last one." } : { alert: result.error };
}

/** Staff record the customer's "no" (e.g. by phone) on a quote awaiting payment. */
export async function declineTicketQuote(shop: Shop, ticketId: number, reason: string): Promise<Outcome> {
  const quotation = await requireQuotation(shop, ticketId);
  if (!quotation) return { alert: "There's no quote on this ticket." };
  const result = await declineQuote({
    shopId: shop.id,
    quotationId: quotation.id,
    reason: reason.trim() || null,
    by: "staff",
  });
  return result.ok ? { notice: "Quote declined on the customer's behalf." } : { alert: result.error };
}

/** Apply or remove the ticket's cover on the draft quote (e.g. the fault isn't covered). */
export async function updateQuoteCover(shop: Shop, ticketId: number, apply: boolean): Promise<Outcome> {
  const ticket = await findTicket(shop, ticketId);
  const quotation = await currentQuotation(ticket.id);
  const cover = ticket.coverId ? await prisma.cover.findUnique({ where: { id: ticket.coverId } }) : null;
  if (quotation?.status !== "draft" || !cover) return { alert: "There's no draft quote with cover to change." };
  await applyCover(quotation.id, apply ? cover : null);
  await createTicketActivity({
    repairTicketId: ticket.id,
    activityType: "note",
    author: "staff",
    body: apply
      ? `${coverName(cover)} applied to the quote.`
      : `${coverName(cover)} not applied: repair charged in full.`,
  });
  return { notice: apply ? "Cover applied." : "Cover removed from the quote." };
}

// --- Parts on a ticket (Workshop inventory) -----------------------------------------

export async function planParts(shop: Shop, admin: AdminGraphqlClient, ticketId: number): Promise<Outcome> {
  requireParts(shop);
  const ticket = await findTicket(shop, ticketId);
  const planned = await planTicketParts({ shopId: shop.id, ticketId: ticket.id }, { client: admin });
  if (!planned.length) return { notice: "No recipe parts: add services with recipes to the quote first." };
  const unmatched = planned.filter((tp) => tp.partVariantId === null).length;
  let notice = `${planned.length} ${planned.length === 1 ? "part" : "parts"} planned from the quote's services.`;
  if (unmatched > 0) notice += ` Choose a variant for ${unmatched}.`;
  return { notice };
}

export async function addTicketPart(
  shop: Shop,
  ticketId: number,
  { partId, variantId, quantity }: { partId: number; variantId: number | null; quantity: string | null },
): Promise<Outcome> {
  requireParts(shop);
  const ticket = await findTicket(shop, ticketId);
  const part = orNotFound(
    await prisma.part.findFirst({
      where: { id: partId, shopId: shop.id },
      include: { variants: { orderBy: { id: "asc" } } },
    }),
  );
  const variant =
    part.variants.find((v) => v.id === variantId) ?? (partOptionNames(part).length ? null : part.variants[0] ?? null);
  try {
    await createTicketPart({
      repairTicketId: ticket.id,
      partId: part.id,
      partVariantId: variant?.id ?? null,
      quantity: quantity ?? 1,
    });
  } catch (error) {
    if (error instanceof ValidationError) return { alert: toSentenceMessages(error) };
    throw error;
  }
  return { notice: `${part.name} added.` };
}

async function findTicketPart(shop: Shop, ticketId: number, ticketPartId: number) {
  const ticket = await findTicket(shop, ticketId);
  return orNotFound(
    await prisma.ticketPart.findFirst({
      where: { id: ticketPartId, repairTicketId: ticket.id },
      include: { part: { include: { variants: true } } },
    }),
  );
}

export async function updateTicketPart(
  shop: Shop,
  ticketId: number,
  ticketPartId: number,
  { variantId, quantity }: { variantId: number | null; quantity: string | null },
): Promise<Outcome> {
  requireParts(shop);
  const tp = await findTicketPart(shop, ticketId, ticketPartId);
  if (isConsumed(tp)) return { alert: "That part has already been used." };
  const variant = tp.part.variants.find((v) => v.id === variantId);
  const data = {
    partVariantId: variant?.id ?? tp.partVariantId,
    quantity: quantity ? new Prisma.Decimal(quantity) : tp.quantity,
  };
  try {
    assertValid("TicketPart", await validateTicketPart({ ...data, partId: tp.partId }));
  } catch (error) {
    if (error instanceof ValidationError) return { alert: toSentenceMessages(error) };
    throw error;
  }
  await prisma.ticketPart.update({ where: { id: tp.id }, data });
  return { notice: "Part updated." };
}

export async function removeTicketPart(shop: Shop, ticketId: number, ticketPartId: number): Promise<Outcome> {
  requireParts(shop);
  const tp = await findTicketPart(shop, ticketId, ticketPartId);
  if (isConsumed(tp)) return { alert: "That part has already been taken from stock." };
  await prisma.ticketPart.delete({ where: { id: tp.id } });
  return { notice: "Part removed." };
}


// --- Postage (the customer posts the item) ----------------------------------------------

/** "Mark received": the customer's parcel arrived. */
export async function markTicketReceived(shop: Shop, ticketId: number): Promise<Outcome> {
  const ticket = await findTicket(shop, ticketId);
  const result = await markItemReceived({ shopId: shop.id, ticketId: ticket.id, actor: "staff" });
  return result.ok ? { notice: result.message } : { alert: result.error };
}

/** "Mark returned": fulfil the repair order with tracking; Shopify emails the customer. */
export async function markTicketReturned(
  shop: Shop,
  admin: AdminGraphqlClient,
  ticketId: number,
  tracking: Tracking,
): Promise<Outcome> {
  const ticket = await findTicket(shop, ticketId);
  const result = await returnRepairedItem({ shopId: shop.id, ticketId: ticket.id, actor: "staff", tracking, client: admin });
  return result.ok ? { notice: result.message } : { alert: result.error };
}

