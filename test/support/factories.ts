/**
 * Fixture builders, the TypeScript counterpart of the Rails
 * test/support/*_fixtures.rb modules: `build*` returns attributes with
 * sensible defaults, `create*` saves them (through the model layer's
 * validating create functions where there is one, like Rails `create!`).
 * Override only what a test cares about.
 */
import type { Prisma, Session, Shop } from "@prisma/client";
import prisma from "../../app/db.server";
import { createCareCredit } from "../../app/models/care-credit.server";
import { type CarePlanInput, createCarePlan } from "../../app/models/care-plan.server";
import { createCover, warrantyCoverFor } from "../../app/models/cover.server";
import { createItem } from "../../app/models/item.server";
import { createNotificationDelivery } from "../../app/models/notification-delivery.server";
import { createPartImport } from "../../app/models/part-import.server";
import { createPart, generateVariants, type PartInput } from "../../app/models/part.server";
import { createPartVariant, type PartVariantInput } from "../../app/models/part-variant.server";
import { createProcessedRefund } from "../../app/models/processed-refund.server";
import { createProductGroup, type ProductGroupInput } from "../../app/models/product-group.server";
import { createQuotation } from "../../app/models/quotation.server";
import {
  createQuotationLineItem,
  type QuotationLineItemInput,
} from "../../app/models/quotation-line-item.server";
import { createRegistration } from "../../app/models/registration.server";
import { createRepairService } from "../../app/models/repair-service.server";
import { createRepairTicket } from "../../app/models/repair-ticket.server";
import { createServiceComponent } from "../../app/models/service-component.server";
import { createStockMovement } from "../../app/models/stock-movement.server";
import { createTicketActivity } from "../../app/models/ticket-activity.server";
import { createTicketImage } from "../../app/models/ticket-image.server";
import { createTicketPart } from "../../app/models/ticket-part.server";
import { createTradeIn } from "../../app/models/trade-in.server";
import {
  createTradeInProgram,
  DEFAULT_GRADES,
  type TradeInProgramInput,
} from "../../app/models/trade-in-program.server";
import {
  createWarrantyPolicy,
  type WarrantyPolicyInput,
} from "../../app/models/warranty-policy.server";

let sequence = 0;
/** A unique number per call, for ids and shop domains that must not collide. */
export const nextId = () => ++sequence;

/** n days before now (Rails `n.days.ago`). */
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

type Without<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

// --- Session / Shop -----------------------------------------------------------

export function buildSession(
  overrides: Partial<Prisma.SessionCreateInput> = {},
): Prisma.SessionCreateInput {
  const shop = overrides.shop ?? `shop-${nextId()}.myshopify.com`;
  return {
    id: `offline_${shop}`,
    shop,
    state: "state",
    isOnline: false,
    scope: "read_products",
    accessToken: "shpat_test_token",
    ...overrides,
  };
}

export function createSession(
  overrides: Partial<Prisma.SessionCreateInput> = {},
): Promise<Session> {
  return prisma.session.create({ data: buildSession(overrides) });
}

export function buildShop(
  overrides: Partial<Prisma.ShopUncheckedCreateInput> = {},
): Prisma.ShopUncheckedCreateInput {
  return { shopifyDomain: `shop-${nextId()}.myshopify.com`, ...overrides };
}

export function createShop(overrides: Partial<Prisma.ShopUncheckedCreateInput> = {}): Promise<Shop> {
  return prisma.shop.create({ data: buildShop(overrides) });
}

// --- Products, cover ----------------------------------------------------------

export function createProductGroupFor(shop: Shop, overrides: Partial<ProductGroupInput> = {}) {
  return createProductGroup({ shopId: shop.id, name: `Group ${nextId()}`, rule: "all", ...overrides });
}

export function createWarrantyPolicyFor(
  shop: Shop,
  overrides: Partial<WarrantyPolicyInput> = {},
) {
  return createWarrantyPolicy({ shopId: shop.id, name: "12-month warranty", months: 12, ...overrides });
}

export function createCarePlanFor(shop: Shop, overrides: Partial<CarePlanInput> = {}) {
  return createCarePlan({
    shopId: shop.id,
    name: "2-year Care",
    shopifyVariantId: `70${nextId()}`,
    price: 15,
    termMonths: 24,
    ...overrides,
  });
}

export function buildItem(
  shop: Shop,
  overrides: Partial<Prisma.ItemUncheckedCreateInput> = {},
): Prisma.ItemUncheckedCreateInput {
  return { shopId: shop.id, productTitle: "Aria Boot", purchasedAt: daysAgo(30), ...overrides };
}

export function createItemFor(shop: Shop, overrides: Partial<Prisma.ItemUncheckedCreateInput> = {}) {
  return createItem(buildItem(shop, overrides));
}

/** A saved warranty cover on `item` from `policy` (both created if not given). */
export async function createWarrantyCover(
  shop: Shop,
  {
    item,
    policy,
  }: {
    item?: Awaited<ReturnType<typeof createItemFor>>;
    policy?: Awaited<ReturnType<typeof createWarrantyPolicyFor>>;
  } = {},
) {
  const theItem = item ?? (await createItemFor(shop));
  const thePolicy = policy ?? (await createWarrantyPolicyFor(shop));
  return createCover(warrantyCoverFor(theItem, thePolicy));
}

export function createRegistrationFor(
  shop: Shop,
  itemId: number,
  overrides: Partial<Prisma.RegistrationUncheckedCreateInput> = {},
) {
  return createRegistration({ shopId: shop.id, itemId, retailer: "A stockist", ...overrides });
}

export function createCareCreditFor(
  shop: Shop,
  coverId: number,
  overrides: Partial<Prisma.CareCreditUncheckedCreateInput> = {},
) {
  return createCareCredit({ shopId: shop.id, coverId, code: `CARE-${nextId()}`, amount: 15, ...overrides });
}

// --- Repairs --------------------------------------------------------------------

export function buildRepairTicket(
  shop: Shop,
  overrides: Partial<Prisma.RepairTicketUncheckedCreateInput> = {},
): Prisma.RepairTicketUncheckedCreateInput {
  return { shopId: shop.id, customerEmail: "c@example.com", productTitle: "Boot", ...overrides };
}

export function createRepairTicketFor(
  shop: Shop,
  overrides: Partial<Prisma.RepairTicketUncheckedCreateInput> = {},
) {
  return createRepairTicket(buildRepairTicket(shop, overrides));
}

export function createQuotationFor(
  repairTicketId: number,
  overrides: Partial<Prisma.QuotationUncheckedCreateInput> = {},
) {
  return createQuotation({ repairTicketId, currency: "GBP", ...overrides });
}

export function createLineItem(
  quotationId: number,
  overrides: Partial<Without<QuotationLineItemInput, "quotationId">> = {},
) {
  return createQuotationLineItem({ quotationId, kind: "extra", title: "Part", quantity: 1, unitPrice: 10, ...overrides });
}

export function createTicketActivityFor(
  repairTicketId: number,
  overrides: Partial<Prisma.TicketActivityUncheckedCreateInput> = {},
) {
  return createTicketActivity({ repairTicketId, activityType: "note", author: "staff", body: "Note", ...overrides });
}

export function createTicketImageFor(
  repairTicketId: number,
  overrides: Partial<Prisma.TicketImageUncheckedCreateInput> = {},
) {
  return createTicketImage({
    repairTicketId,
    storageKey: `tickets/${repairTicketId}/photo-${nextId()}.jpg`,
    filename: "photo.jpg",
    contentType: "image/jpeg",
    byteSize: 1024,
    ...overrides,
  });
}

// --- Workshop -------------------------------------------------------------------

export function createRepairServiceFor(
  shop: Shop,
  overrides: Partial<Prisma.RepairServiceUncheckedCreateInput> = {},
) {
  return createRepairService({ shopId: shop.id, title: "Resole", shopifyVariantId: `9${nextId()}`, price: 60, ...overrides });
}

export function createPartFor(shop: Shop, overrides: Partial<PartInput> = {}) {
  return createPart({ shopId: shop.id, name: `Part ${nextId()}`, ...overrides });
}

export function createPartVariantFor(partId: number, overrides: Partial<PartVariantInput> = {}) {
  return createPartVariant({ partId, ...overrides });
}

export function createServiceComponentFor(
  repairServiceId: number,
  partId: number,
  overrides: Partial<Prisma.ServiceComponentUncheckedCreateInput> = {},
) {
  return createServiceComponent({ repairServiceId, partId, quantity: 1, ...overrides });
}

export function createStockMovementFor(
  shop: Shop,
  partVariantId: number,
  overrides: Partial<Prisma.StockMovementUncheckedCreateInput> = {},
) {
  return createStockMovement({ shopId: shop.id, partVariantId, quantity: 1, reason: "received", ...overrides });
}

export function createTicketPartFor(
  repairTicketId: number,
  partId: number,
  overrides: Partial<Prisma.TicketPartUncheckedCreateInput> = {},
) {
  return createTicketPart({ repairTicketId, partId, quantity: 1, ...overrides });
}

export function createPartImportFor(
  shop: Shop,
  overrides: Partial<Prisma.PartImportUncheckedCreateInput> = {},
) {
  return createPartImport({
    shopId: shop.id,
    filename: "parts.csv",
    mode: "parts",
    csvData: "name,unit\nAdhesive,ml\n",
    ...overrides,
  });
}

// --- Notifications, refunds -------------------------------------------------------

export function createNotificationDeliveryFor(
  shop: Shop,
  overrides: Partial<Prisma.NotificationDeliveryUncheckedCreateInput> = {},
) {
  return createNotificationDelivery({ shopId: shop.id, event: "repair_status_changed", channel: "email", ...overrides });
}

export function createProcessedRefundFor(
  shop: Shop,
  overrides: Partial<Prisma.ProcessedRefundUncheckedCreateInput> = {},
) {
  return createProcessedRefund({ shopId: shop.id, refundId: `${nextId()}`, ...overrides });
}

// --- Trade-in (parked) -------------------------------------------------------------

/** Rails TradeInFixtures#build_program: fixed credit, Excellent £40 / Good £25 / Worn £10. */
export function buildProgram(shop: Shop, overrides: Partial<TradeInProgramInput> = {}) {
  return createTradeInProgram({
    shopId: shop.id,
    name: "Trade-in",
    grades: [...DEFAULT_GRADES],
    instructions: "Post it to us.",
    ...overrides,
  });
}

export function createTradeInFor(
  shop: Shop,
  overrides: Partial<Prisma.TradeInUncheckedCreateInput> = {},
) {
  return createTradeIn({ shopId: shop.id, productTitle: "Aria Boot", ...overrides });
}

// --- Rails fixture modules ---------------------------------------------------------

/**
 * Rails CareFixtures#build_care: a "Resole" (variant 900) and "Heel" (901)
 * service and a 2-year Care plan linked to Care variant 7001 (product 700).
 */
export async function buildCare(shop: Shop, planAttrs: Partial<CarePlanInput> = {}) {
  const resole = await createRepairService({ shopId: shop.id, title: "Resole", shopifyVariantId: "900", price: 60 });
  const heel = await createRepairService({ shopId: shop.id, title: "Heel", shopifyVariantId: "901", price: 20 });
  const plan = await createCarePlan({
    shopId: shop.id,
    name: "2-year Care",
    shopifyVariantId: "7001",
    shopifyProductId: "700",
    price: 15,
    termMonths: 24,
    ...planAttrs,
  });
  return { plan, resole, heel };
}

/**
 * Rails PartsFixtures#build_workshop: a sole part in model × size, an
 * adhesive with no variants, and a "Resole" service whose recipe uses both.
 */
export async function buildWorkshop(shop: Shop) {
  const sole = await createPart({
    shopId: shop.id,
    name: "Commando sole",
    unit: "pair",
    costPerUnit: 12,
    reorderLevel: 2,
    reorderQuantity: 10,
    optionNames: ["model", "size"],
  });
  await generateVariants(sole.id, { model: ["Commando", "Gumlite"], size: ["UK 7", "UK 8"] });
  const glue = await createPart({
    shopId: shop.id,
    name: "Adhesive",
    unit: "ml",
    packSize: 500,
    costPerUnit: 0.02,
    reorderLevel: 200,
  });
  const service = await createRepairService({
    shopId: shop.id,
    title: "Resole",
    shopifyVariantId: "900",
    price: 60,
    labourMinutes: 45,
  });
  await createServiceComponent({ repairServiceId: service.id, partId: sole.id, quantity: 1 });
  await createServiceComponent({ repairServiceId: service.id, partId: glue.id, quantity: 30 });
  return { sole, glue, service };
}
