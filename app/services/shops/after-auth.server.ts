/**
 * Runs after a merchant authenticates (`hooks.afterAuth` in
 * app/shopify.server.ts; Rails `after_authenticate_job`): makes sure the Shop
 * row exists and the customer signing key is created, encrypted on the shop
 * and published to the app-data metafield Liquid reads.
 * Then, once per shop, it queues the order backfill ("import-orders" job:
 * Items + cover from the last 60 days of paid orders), as Rails'
 * after_authenticate_job did. Token exchange runs this often, so each step
 * only does its work once.
 */
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import {
  customerSigningKeyState,
  findOrCreateShop,
  saveCustomerSigningKey,
} from "../../models/shop.server";
import { ensureCustomerSigningKey } from "../../shopify/customer-signing-key.server";
import { queueOrderImport, type ImportOrdersDeps } from "../../jobs/import-orders.server";
import { errorSummary, type AdminGraphqlClient } from "../../shopify/graphql.server";
import { storefrontChanged } from "../storefront/storefront-sync.server";

export async function setUpShopAfterAuth(
  shopDomain: string,
  client: AdminGraphqlClient,
  db: Db = prisma,
  enqueue?: ImportOrdersDeps["enqueue"],
): Promise<void> {
  const shop = await findOrCreateShop(shopDomain, db);
  if (shop.uninstalledAt) {
    await db.shop.update({
      where: { id: shop.id },
      data: { uninstalledAt: null, installedAt: new Date() },
    });
  }
  try {
    await ensureCustomerSigningKey(
      client,
      customerSigningKeyState(shop),
      saveCustomerSigningKey(shop.id, db),
    );
  } catch (error) {
    // Not fatal for the admin: logged-in customers still verify through
    // Shopify's logged_in_customer_id; the next login retries the publish.
    console.error(
      `[afterAuth] ${shopDomain}: customer signing key: ${errorSummary(error)}`,
    );
  }
  try {
    const current = await db.shop.findUniqueOrThrow({ where: { id: shop.id } });
    await queueOrderImport(current, { db: db as typeof prisma, enqueue });
  } catch (error) {
    console.error(`[afterAuth] ${shopDomain}: order backfill not queued: ${errorSummary(error)}`);
  }
  // Care plans for the product page block (never throws).
  await storefrontChanged(shop);
}
