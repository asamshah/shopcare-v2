/**
 * Runs after a merchant authenticates (`hooks.afterAuth` in
 * app/shopify.server.ts; Rails `after_authenticate_job`): makes sure the Shop
 * row exists and the customer signing key is created, encrypted on the shop
 * and published to the app-data metafield Liquid reads.
 *
 * TODO(wave 2, webhooks/jobs): enqueue the order backfill here
 * (Items::OrderImporter), as Rails' after_authenticate_job did.
 */
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import {
  customerSigningKeyState,
  findOrCreateShop,
  saveCustomerSigningKey,
} from "../../models/shop.server";
import { ensureCustomerSigningKey } from "../../shopify/customer-signing-key.server";
import { errorSummary, type AdminGraphqlClient } from "../../shopify/graphql.server";

export async function setUpShopAfterAuth(
  shopDomain: string,
  client: AdminGraphqlClient,
  db: Db = prisma,
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
}
