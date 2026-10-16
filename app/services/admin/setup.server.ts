/**
 * First-run setup, shown on the admin home (tickets) until the merchant
 * finishes or skips it: (1) product groups, (2) repair services, (3) warranty
 * and Care (and, optionally, workshop inventory). Port of SetupController and
 * setup/_wizard.
 */
import type { Prisma, Shop } from "@prisma/client";
import prisma from "../../db.server";
import { pluralize } from "../../lib/format";
import { toSentence } from "../../lib/inflections";
import { productGroupSummary } from "../../models/product-group.server";
import { needsSetup, partsEnabled, settingsOf, useRepairCollection as rememberRepairCollection } from "../../models/shop.server";
import { jsonObject, ValidationError } from "../../models/validation.server";
import { createWarrantyPolicy } from "../../models/warranty-policy.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import { errorSummary } from "../../shopify/graphql.server";
import { importRepairServices, type RepairCatalog, shopifyRepairCatalog } from "../repairs/service-import.server";
import { orNotFound } from "./context.server";
import type { Flash } from "./flash.server";

export const WARRANTY_PRESET_MONTHS = 12;

export async function groupOptions(shopId: number) {
  const groups = await prisma.productGroup.findMany({ where: { shopId }, orderBy: [{ name: "asc" }, { id: "asc" }] });
  return groups.map((g) => ({ id: g.id, name: g.name, summary: productGroupSummary(g) }));
}

export async function wizardData(shop: Shop, rawStep: string | null) {
  if (!needsSetup(shop)) return null;
  const parsed = parseInt(rawStep ?? "1", 10);
  const step = Math.min(Math.max(Number.isNaN(parsed) ? 1 : parsed, 1), 3);
  const [groups, servicesCount, policies, plansCount] = await Promise.all([
    groupOptions(shop.id),
    prisma.repairService.count({ where: { shopId: shop.id, active: true } }),
    prisma.warrantyPolicy.findMany({ where: { shopId: shop.id }, orderBy: [{ position: "asc" }, { id: "asc" }] }),
    prisma.carePlan.count({ where: { shopId: shop.id } }),
  ]);
  return {
    step,
    groups,
    groupNames: toSentence(groups.map((g) => g.name)),
    servicesCount,
    servicesLabel: pluralize(servicesCount, "repair service"),
    policyNames: toSentence(policies.map((p) => p.name)),
    plansLabel: plansCount ? pluralize(plansCount, "Care plan") : null,
    partsEnabled: partsEnabled(shop),
    presetMonths: WARRANTY_PRESET_MONTHS,
  };
}

/** Step 2: import repair services from a chosen collection, or products tagged "repair". */
export async function setupServices(
  shop: Shop,
  admin: AdminGraphqlClient,
  { collectionId, collectionTitle }: { collectionId: string; collectionTitle: string },
  catalogFor: (shop: Shop) => RepairCatalog = (s) => shopifyRepairCatalog(s, admin),
): Promise<Flash> {
  let updated: Shop;
  if (collectionId) {
    updated = await rememberRepairCollection(shop, collectionId, collectionTitle);
  } else {
    const settings = settingsOf(shop);
    const current = jsonObject(settings.repair_products as Prisma.JsonValue);
    const tag = typeof current.tag === "string" && current.tag.trim() ? current.tag : "repair";
    updated = await prisma.shop.update({
      where: { id: shop.id },
      data: { settings: { ...settings, repair_products: { ...current, mode: "tag", tag } } as Prisma.InputJsonValue },
    });
  }
  try {
    const counts = await importRepairServices(updated.id, catalogFor(updated));
    if (!counts) return { alert: "Choose the collection that holds your repair products." };
    return { notice: `Imported ${pluralize(counts.added + counts.updated, "repair service")}.` };
  } catch (error) {
    return { alert: `We couldn't read your products from Shopify: ${errorSummary(error)}` };
  }
}

/** Step 3: a default warranty, free repair for N months, on a product group (or everything). */
export async function setupWarranty(
  shop: Shop,
  { months, productGroupId }: { months: number | null; productGroupId: number | null },
): Promise<Flash> {
  const length = months && months > 0 ? months : WARRANTY_PRESET_MONTHS;
  if (productGroupId) {
    orNotFound(await prisma.productGroup.findFirst({ where: { id: productGroupId, shopId: shop.id } }));
  }
  const last = await prisma.warrantyPolicy.aggregate({ where: { shopId: shop.id }, _max: { position: true } });
  try {
    const policy = await createWarrantyPolicy({
      shopId: shop.id,
      name: `${length}-month warranty`,
      months: length,
      outcome: "free",
      productGroupId,
      position: (last._max.position ?? -1) + 1,
    });
    return { notice: `${policy.name} switched on.` };
  } catch (error) {
    if (error instanceof ValidationError) return { alert: error.errors.fullMessages().join(", ") };
    throw error;
  }
}

/** Finish or skip; finishing also records the optional "track workshop inventory" choice. */
export async function completeSetup(
  shop: Shop,
  { skipped, partsEnabled: parts }: { skipped: boolean; partsEnabled: boolean | null },
): Promise<Flash> {
  const settings = settingsOf(shop);
  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      setupCompletedAt: new Date(),
      ...(parts === null ? {} : { settings: { ...settings, parts_enabled: parts } as Prisma.InputJsonValue }),
    },
  });
  return {
    notice: skipped ? "Setup skipped. Everything is in the menu when you need it." : "You're all set.",
  };
}
