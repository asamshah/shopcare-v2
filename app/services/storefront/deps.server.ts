/**
 * What the storefront (App Proxy) routes depend on beyond the proxy plumbing
 * in app/lib/app-proxy.server.ts: the shop's Admin API client, file storage,
 * notifications, background jobs and the quote decision service. Production
 * wiring is the default; tests swap pieces with `configureStorefront`.
 */
import type { Shop } from "@prisma/client";
import prisma from "../../db.server";
import {
  proxyRoute,
  type ProxyRouteContext,
  type ProxyRouteOptions,
} from "../../lib/app-proxy.server";
import type { JobPayload } from "../../jobs/registry.server";
import { getStorage, type FileStorage } from "../../lib/storage.server";
import { jsonResponse } from "../../lib/http.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import { getNotificationDeps, type NotificationDeps } from "../notifications.server";
import { declineQuote, expireQuote } from "../quotes/decision.server";

export interface StorefrontDeps {
  /** The shop's Admin API client (the proxy's offline-session client). */
  adminClient(ctx: ProxyRouteContext): Promise<AdminGraphqlClient>;
  storage(): FileStorage;
  notifications(): Pick<NotificationDeps, "store" | "enqueue">;
  /** Background enqueue for the outbound webhook; default app/lib/background.server. */
  enqueue?: (name: "outbound-webhook", payload: JobPayload) => Promise<void>;
  /** Owned by w2-backend (app/services/quotes/decision.server.ts). */
  declineQuote: typeof declineQuote;
  expireQuote: typeof expireQuote;
  now(): Date;
}

const defaults: StorefrontDeps = {
  async adminClient(ctx) {
    if (process.env.VITEST)
      throw new Error("Storefront routes call Shopify: configureStorefront({ adminClient }) in tests.");
    if (ctx.admin) return ctx.admin;
    const { adminClientForShop } = await import("../../shopify/client.server");
    return adminClientForShop(ctx.shop);
  },
  storage: () => getStorage(),
  notifications: () => getNotificationDeps(),
  declineQuote: (args) => declineQuote(args),
  expireQuote: (args) => expireQuote(args),
  now: () => new Date(),
};

let current: StorefrontDeps = { ...defaults };

/** Swap dependencies (tests). Returns a restore function. */
export function configureStorefront(overrides: Partial<StorefrontDeps>): () => void {
  const previous = current;
  current = { ...current, ...overrides };
  return () => {
    current = previous;
  };
}

export function storefrontDeps(): StorefrontDeps {
  return current;
}

export interface StorefrontContext extends ProxyRouteContext {
  /** The shop's row (Rails `@shop`). */
  shopRecord: Shop;
  deps: StorefrontDeps;
}

/**
 * `proxyRoute` plus Rails `set_shop`: a shop with no row gets a 404, like
 * `head :not_found`.
 */
export function storefrontRoute(
  options: ProxyRouteOptions,
  handler: (ctx: StorefrontContext) => Promise<Response> | Response,
): (args: { request: Request }) => Promise<Response> {
  return proxyRoute(options, async (ctx) => {
    const shopRecord = await prisma.shop.findUnique({ where: { shopifyDomain: ctx.shop } });
    if (!shopRecord) {
      return jsonResponse({ ok: false, error: "Not found" }, { cache: "no-store", status: 404 });
    }
    const storefront = Object.create(ctx, {
      shopRecord: { value: shopRecord },
      deps: { value: current },
    }) as StorefrontContext;
    return handler(storefront);
  });
}

/**
 * Form fields the way Rails `params` reads them: the request body
 * (multipart or urlencoded) over the query string.
 */
export async function formParams(ctx: ProxyRouteContext): Promise<FormData> {
  let body: FormData | null = null;
  const type = ctx.request.headers.get("content-type") ?? "";
  if (/multipart\/form-data|application\/x-www-form-urlencoded/i.test(type)) {
    try {
      body = await ctx.request.formData();
    } catch {
      body = null;
    }
  }
  const merged = new FormData();
  for (const [key, value] of ctx.params) merged.append(key, value);
  if (body) {
    for (const key of new Set(body.keys())) merged.delete(key);
    for (const [key, value] of body) merged.append(key, value);
  }
  return merged;
}

/** One text field (null when absent; files ignored). */
export function textParam(form: FormData, key: string): string | null {
  const value = form.get(key);
  return typeof value === "string" ? value : null;
}
