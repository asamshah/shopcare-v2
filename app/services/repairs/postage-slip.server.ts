/**
 * Postage slips: the PDF a customer prints to post their item to the
 * workshop (drawn by app/lib/pdf/postage-slip-pdf.ts).
 *
 * One stored file per ticket, `shops/<shop id>/tickets/<id>/postage-slip.pdf`,
 * remembered on the ticket with a digest of everything it was drawn from
 * (workshop address, posting instructions, store name, customer, product,
 * quote lines, layout version). `ensurePostageSlip` returns the stored file
 * while the digest still matches and redraws it when anything changed, so
 * the email attachment, the storefront download and the admin download are
 * the same file and change together.
 *
 * Download links: the email and the storefront Repair status block link to
 * the App Proxy route `/apps/repairs/tickets/:id/postage-slip`. The email's
 * link is signed (HMAC under a key derived from APP_ENCRYPTION_KEY) and
 * expires after POSTAGE_LINK_DAYS, so guests can use it; without a valid
 * signature only the logged-in customer who owns the ticket gets the file.
 */
import { createHash } from "node:crypto";
import type { Prisma, RepairTicket, Shop } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { renderPostageSlip, type PostageSlipInput } from "../../lib/pdf/postage-slip-pdf";
import { derivedSecret, hmacHex, safeEqualHex } from "../../lib/signing.server";
import { getStorage, type FileStorage } from "../../lib/storage.server";
import { currentQuotation } from "../../models/repair-ticket.server";
import {
  adminTicketUrl,
  completeWorkshopAddress,
  postingInstructions,
  proxyPathPrefix,
  proxyUrl,
  settingsOf,
  workshopAddressLines,
} from "../../models/shop.server";
import { jsonObject } from "../../models/validation.server";
import { storeNameFromDomain } from "../../shopify/shop.server";
import type { EmailAttachment } from "../email.server";
import { DeliveryError } from "../notifications/delivery-error.server";
import type { NotificationDelivery } from "../notifications/store.server";

/** Bump when the layout changes, so stored slips are redrawn. */
export const POSTAGE_SLIP_VERSION = 1;
/** How long the emailed download link works. */
export const POSTAGE_LINK_DAYS = 30;
/** How long the Repair status block's link works (the page is per visit). */
export const STATUS_LINK_HOURS = 24;

export const MISSING_WORKSHOP_ADDRESS =
  "Add your workshop address in Settings → Repairs before postage slips can be made.";

export class MissingWorkshopAddressError extends Error {
  constructor() {
    super(MISSING_WORKSHOP_ADDRESS);
    this.name = "MissingWorkshopAddressError";
  }
}

export function postageSlipKey(shopId: number, ticketId: number): string {
  return `shops/${shopId}/tickets/${ticketId}/postage-slip.pdf`;
}

export function postageSlipFilename(ticketId: number): string {
  return `repair-${ticketId}-postage-slip.pdf`;
}

type SlipTicket = Pick<
  RepairTicket,
  "id" | "customerName" | "customerEmail" | "customerAddress" | "productTitle" | "variantTitle" | "description"
>;

/** The customer's return address lines from the ticket (intake's address fields). */
export function customerAddressLines(address: Prisma.JsonValue): string[] {
  const a = jsonObject(address);
  const text = (key: string) => (typeof a[key] === "string" ? String(a[key]).trim() : "");
  return [
    text("address1"),
    text("address2"),
    [text("city"), text("province"), text("zip")].filter(Boolean).join(" "),
    text("country"),
  ].filter(Boolean);
}

/** Everything on the slip except the date. Throws when there's no workshop address. */
export async function postageSlipInput(
  shop: Pick<Shop, "id" | "shopifyDomain" | "settings">,
  ticket: SlipTicket,
  db: Db = prisma,
): Promise<Omit<PostageSlipInput, "date">> {
  const workshop = completeWorkshopAddress(shop);
  if (!workshop) throw new MissingWorkshopAddressError();
  const quotation = await currentQuotation(ticket.id, db);
  const lines = quotation
    ? await db.quotationLineItem.findMany({
        where: { quotationId: quotation.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    : [];
  const name = settingsOf(shop).shop_name;
  return {
    storeName: typeof name === "string" && name.trim() ? name.trim() : storeNameFromDomain(shop.shopifyDomain),
    ticketNumber: ticket.id,
    workshop: workshopAddressLines(workshop),
    customer: {
      name: ticket.customerName?.trim() ?? "",
      email: ticket.customerEmail?.trim() ?? "",
      addressLines: customerAddressLines(ticket.customerAddress),
    },
    product: ticket.productTitle?.trim() || "Your item",
    variant: ticket.variantTitle?.trim() || null,
    repair: lines.length
      ? { heading: "Repairs quoted", lines: lines.map((line) => `${line.title} × ${line.quantity}`) }
      : { heading: "What you told us", lines: ticket.description?.trim() ? [ticket.description.trim()] : [] },
    qrUrl: adminTicketUrl(shop.shopifyDomain, ticket.id),
    instructions: postingInstructions(shop),
  };
}

export function postageSlipDigest(input: Omit<PostageSlipInput, "date">): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: POSTAGE_SLIP_VERSION, ...input }))
    .digest("hex");
}

export interface PostageSlipFile {
  key: string;
  filename: string;
  content: Uint8Array;
  /** True when it was (re)drawn now rather than read from storage. */
  generated: boolean;
}

export interface PostageSlipOptions {
  db?: Db;
  storage?: FileStorage;
  now?: Date;
}

/**
 * The ticket's postage slip: the stored one while nothing it shows has
 * changed, else drawn again and stored. Throws MissingWorkshopAddressError
 * when Settings → Repairs has no workshop address.
 */
export async function ensurePostageSlip(
  shop: Pick<Shop, "id" | "shopifyDomain" | "settings">,
  ticketId: number,
  { db = prisma, storage = getStorage(), now = new Date() }: PostageSlipOptions = {},
): Promise<PostageSlipFile> {
  const ticket = await db.repairTicket.findFirstOrThrow({ where: { id: ticketId, shopId: shop.id } });
  const input = await postageSlipInput(shop, ticket, db);
  const digest = postageSlipDigest(input);
  const key = postageSlipKey(shop.id, ticket.id);
  const filename = postageSlipFilename(ticket.id);

  if (ticket.postageSlipKey === key && ticket.postageSlipDigest === digest) {
    const stored = await storage.get(key);
    if (stored) return { key, filename, content: new Uint8Array(stored.body), generated: false };
  }
  const { pdf } = await renderPostageSlip({ ...input, date: now });
  await storage.put(key, pdf, {
    contentType: "application/pdf",
    metadata: { shop: shop.shopifyDomain, ticket: String(ticket.id) },
  });
  await db.repairTicket.update({
    where: { id: ticket.id },
    data: { postageSlipKey: key, postageSlipDigest: digest },
  });
  return { key, filename, content: pdf, generated: true };
}

/** A PDF download response: private, never cached. */
export function postageSlipResponse(file: Pick<PostageSlipFile, "content" | "filename">, disposition = "inline") {
  return new Response(Buffer.from(file.content), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "Netlify-CDN-Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// --- Signed download links ----------------------------------------------------

const secret = () => derivedSecret("shopcare:postage-slip");

function linkSignature(shopDomain: string, ticketId: number, expires: number): string {
  return hmacHex(secret(), `${shopDomain}\n${ticketId}\n${expires}`);
}

export function postageSlipPath(ticketId: number): string {
  return `tickets/${ticketId}/postage-slip`;
}

function signedQuery(shopDomain: string, ticketId: number, expiresAt: Date): string {
  const expires = Math.floor(expiresAt.getTime() / 1000);
  return `expires=${expires}&token=${linkSignature(shopDomain, ticketId, expires)}`;
}

/** The emailed link: the storefront's App Proxy URL, signed, expiring after `days`. */
export function postageSlipLink(
  shop: Pick<Shop, "shopifyDomain" | "settings">,
  ticketId: number,
  { now = new Date(), days = POSTAGE_LINK_DAYS }: { now?: Date; days?: number } = {},
): string {
  const expiresAt = new Date(now.getTime() + days * 86_400_000);
  return `${proxyUrl(shop, postageSlipPath(ticketId))}?${signedQuery(shop.shopifyDomain, ticketId, expiresAt)}`;
}

/** The Repair status block's link: a path on the storefront, signed for a day. */
export function postageSlipStatusPath(
  shop: Pick<Shop, "shopifyDomain" | "settings">,
  ticketId: number,
  now = new Date(),
): string {
  const expiresAt = new Date(now.getTime() + STATUS_LINK_HOURS * 3_600_000);
  return `${proxyPathPrefix(shop)}/${postageSlipPath(ticketId)}?${signedQuery(shop.shopifyDomain, ticketId, expiresAt)}`;
}

export type LinkCheck = "valid" | "expired" | "invalid" | "missing";

export function verifyPostageSlipLink(
  shopDomain: string,
  ticketId: number,
  params: URLSearchParams,
  now = new Date(),
): LinkCheck {
  const expiresRaw = params.get("expires");
  const token = params.get("token");
  if (!expiresRaw && !token) return "missing";
  const expires = Number(expiresRaw);
  if (!Number.isInteger(expires) || !token) return "invalid";
  if (!safeEqualHex(token, linkSignature(shopDomain, ticketId, expires))) return "invalid";
  return expires * 1000 < now.getTime() ? "expired" : "valid";
}

// --- The email attachment ---------------------------------------------------------

/**
 * NotificationDeps.attachments for production: the postage slip for an
 * item_requested email. A missing workshop address or ticket is permanent.
 */
export async function postageSlipAttachments(
  delivery: Pick<NotificationDelivery, "event" | "shopId" | "payload">,
  options: PostageSlipOptions = {},
): Promise<EmailAttachment[]> {
  if (delivery.event !== "item_requested") return [];
  const db = options.db ?? prisma;
  const ticketId = Number((delivery.payload.data as { ticketId?: unknown }).ticketId);
  const shop = await db.shop.findUnique({ where: { shopifyDomain: delivery.shopId } });
  const ticket =
    shop && Number.isInteger(ticketId)
      ? await db.repairTicket.findFirst({ where: { id: ticketId, shopId: shop.id }, select: { id: true } })
      : null;
  if (!shop || !ticket) throw new DeliveryError("The repair ticket is gone", false);
  try {
    const file = await ensurePostageSlip(shop, ticket.id, options);
    return [{ filename: file.filename, content: file.content, contentType: "application/pdf" }];
  } catch (error) {
    if (error instanceof MissingWorkshopAddressError) throw new DeliveryError(error.message, false);
    throw error;
  }
}
