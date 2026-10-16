/**
 * An Admin API client for a shop outside a merchant request: background jobs,
 * webhook handlers and App Proxy routes. It loads the shop's offline session
 * from session storage (`unauthenticated.admin`), so the shop must have
 * installed the app. Inside an admin route, use `authenticate.admin(request)`'s
 * `admin` instead; both satisfy AdminGraphqlClient.
 *
 * The API version is the one pinned in app/shopify.server.ts (2026-10), which
 * matches `[webhooks] api_version` in shopify.app.toml.
 */
import { unauthenticated } from "../shopify.server";
import type { AdminGraphqlClient } from "./graphql.server";

export async function adminClientForShop(
  shopDomain: string,
): Promise<AdminGraphqlClient> {
  const { admin } = await unauthenticated.admin(shopDomain);
  return admin;
}
