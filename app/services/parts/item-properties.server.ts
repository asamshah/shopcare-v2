/**
 * Fills in the item attributes parts are matched on (size and colour from the
 * variant's options, model from a product metafield), reading them from
 * Shopify once and keeping them on the Item (`properties`, with
 * `fetched_at`). Port of Parts::ItemProperties; the Shopify read is
 * fetchVariantProperties in app/shopify/product-facts.server.ts.
 */
import type { Item, Prisma, Shop } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { partsSettings } from "../../models/shop.server";
import { jsonObject } from "../../models/validation.server";
import { errorSummary, type AdminGraphqlClient } from "../../shopify/graphql.server";
import { fetchVariantProperties } from "../../shopify/product-facts.server";

export const PROPERTY_KEYS = ["size", "colour", "sole_model"] as const;

/** The item's properties, fetching them first if they've never been read. */
export async function itemProperties(
  shop: Pick<Shop, "shopifyDomain" | "settings">,
  client: AdminGraphqlClient,
  item: Pick<Item, "id" | "variantId" | "properties">,
  {
    db = prisma,
    now = new Date(),
    logger = console,
  }: { db?: Db; now?: Date; logger?: Pick<Console, "error"> } = {},
): Promise<Record<string, unknown>> {
  const current = jsonObject(item.properties);
  if (current.fetched_at || !item.variantId) return current;

  const settings = partsSettings(shop);
  let fetched: Record<string, string> | null;
  try {
    fetched = (await fetchVariantProperties(client, item.variantId, {
      modelMetafield: String(settings.model_metafield ?? ""),
      sizeOption: String(settings.size_option ?? ""),
      colourOption: String(settings.colour_option ?? ""),
    })) as Record<string, string> | null;
  } catch (error) {
    logger.error(
      `[parts/item-properties] ${shop.shopifyDomain} variant ${item.variantId}: ${errorSummary(error)}`,
    );
    return current;
  }
  if (!fetched) return current;

  const properties = { ...current, ...fetched, fetched_at: now.toISOString() };
  await db.item.update({
    where: { id: item.id },
    data: { properties: properties as Prisma.InputJsonValue },
  });
  return properties;
}
