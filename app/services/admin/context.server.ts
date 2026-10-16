/**
 * The embedded admin's request context (Rails AdminController): the merchant
 * request is authenticated with `authenticate.admin` (App Bridge session
 * token, or the token-exchange bounce), and the Shop row is the session's
 * shop. Every query in an admin route is scoped to `ctx.shop.id`, so an id
 * from another shop is a 404, never a cross-tenant read.
 *
 * Tests swap the authenticator with `configureAdminAuth` (see
 * test/support/admin.ts) instead of faking Shopify session tokens.
 */
import type { Shop } from "@prisma/client";
import { redirect } from "react-router";
import { findOrCreateShop, partsEnabled, tradeInEnabled } from "../../models/shop.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";

export interface AdminContext {
  shop: Shop;
  admin: AdminGraphqlClient;
}

export type AdminAuthenticator = (
  request: Request,
) => Promise<{ shopDomain: string; admin: AdminGraphqlClient }>;

const shopifyAuthenticator: AdminAuthenticator = async (request) => {
  const { authenticate } = await import("../../shopify.server");
  const { admin, session } = await authenticate.admin(request);
  return { shopDomain: session.shop, admin };
};

let authenticator: AdminAuthenticator = shopifyAuthenticator;

/** Swap the authenticator (tests). Returns a function that restores the previous one. */
export function configureAdminAuth(next: AdminAuthenticator): () => void {
  const previous = authenticator;
  authenticator = next;
  return () => {
    authenticator = previous;
  };
}

export async function requireAdmin(request: Request): Promise<AdminContext> {
  const { shopDomain, admin } = await authenticator(request);
  const shop = await findOrCreateShop(shopDomain);
  return { shop, admin };
}

export function notFound(): never {
  throw new Response("Not Found", { status: 404, statusText: "Not Found" });
}

export function badRequest(message = "Bad Request"): never {
  throw new Response(message, { status: 400, statusText: "Bad Request" });
}

/** A record of this shop, or 404 (Rails `@shop.things.find(id)`). */
export function orNotFound<T>(record: T | null | undefined): T {
  if (record === null || record === undefined) notFound();
  return record;
}

/** An id from the URL or a form: a positive int4, else 404. */
export function parseId(value: string | undefined | null): number {
  if (!value || !/^\d{1,10}$/.test(value)) notFound();
  const id = Number(value);
  if (id < 1 || id > 2_147_483_647) notFound();
  return id;
}

export const HOME_PATH = "/app/tickets";

/** Workshop inventory is optional (Rails `require_parts`). */
export function requireParts(shop: Shop): void {
  if (!partsEnabled(shop)) throw redirect(HOME_PATH);
}

/** Trade-in is parked behind a per-shop flag (Rails `require_trade_in`). */
export function requireTradeIn(shop: Shop): void {
  if (!tradeInEnabled(shop)) throw redirect(HOME_PATH);
}

/** The staff name recorded on stock movements and imports. */
export const STAFF = "staff";
