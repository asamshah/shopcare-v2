/**
 * Running the storefront (App Proxy) routes in integration tests: an
 * installed shop (offline session + Shop row), Shopify-signed requests
 * (appProxyRequest), and the storefront dependencies swapped for fakes
 * (Admin GraphQL, file storage, notifications, background enqueue, quote
 * decisions). Rails test/support/proxy_signing.rb + the per-test stubs.
 */
import type { Prisma, Shop } from "@prisma/client";
import { vi } from "vitest";
import { configureAppProxy } from "../../app/lib/app-proxy.server";
import { memoryThrottleStore } from "../../app/lib/proxy-throttling.server";
import { MemoryStorage } from "../../app/lib/storage.server";
import { MemoryCache, setDefaultShopifyCache } from "../../app/shopify/cache.server";
import {
  configureStorefront,
  type StorefrontDeps,
} from "../../app/services/storefront/deps.server";
import { createSession, createShop } from "./factories";
import { FakeGraphql } from "./fake-graphql";
import { buildDeps } from "./notifications";
import { appProxyRequest } from "./shopify-requests";

type RouteFn = (args: never) => Promise<Response> | Response;

/** Calls a route's loader/action the way React Router does. */
export function runRoute(
  route: RouteFn,
  request: Request,
  params: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    (route as (args: unknown) => Promise<Response> | Response)({
      request,
      params,
      context: {},
    }),
  );
}

/** An installed shop: Shop row + offline session. */
export async function installedShop(
  shopifyDomain: string,
  overrides: Partial<Prisma.ShopUncheckedCreateInput> = {},
): Promise<Shop> {
  await createSession({ shop: shopifyDomain, id: `offline_${shopifyDomain}` });
  return createShop({ shopifyDomain, ...overrides });
}

export interface StorefrontFakes {
  api: FakeGraphql;
  storage: MemoryStorage;
  notifications: ReturnType<typeof buildDeps>;
  enqueued: { name: string; payload: unknown }[];
  restore(): void;
}

/** Swaps the storefront and App Proxy dependencies for fakes. Call restore() after. */
export function fakeStorefront(
  responses: ConstructorParameters<typeof FakeGraphql>[0] = {},
  overrides: Partial<StorefrontDeps> = {},
): StorefrontFakes {
  const api = new FakeGraphql(responses);
  const storage = new MemoryStorage();
  const notifications = buildDeps();
  const enqueued: { name: string; payload: unknown }[] = [];
  const restoreStorefront = configureStorefront({
    adminClient: async () => api,
    storage: () => storage,
    notifications: () => notifications.deps,
    enqueue: vi.fn(async (name, payload) => {
      enqueued.push({ name, payload });
    }),
    ...overrides,
  });
  const restoreProxy = configureAppProxy({ throttleStore: memoryThrottleStore() });
  // A fresh Shopify cache (product facts, catalogue search) per test.
  setDefaultShopifyCache(new MemoryCache());
  return {
    api,
    storage,
    notifications,
    enqueued,
    restore() {
      restoreStorefront();
      restoreProxy();
      setDefaultShopifyCache(undefined);
    },
  };
}

/** A signed GET. */
export function signedGet(
  path: string,
  shop: string,
  { customerId = "", extra = {}, headers = {} }: {
    customerId?: string;
    extra?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Request {
  return appProxyRequest(path, { shop, customerId, extra, init: { headers } });
}

/** A signed POST with a form body (multipart, like the extension's FormData). */
export function signedPost(
  path: string,
  shop: string,
  fields: Record<string, string | Blob | (string | Blob)[]> = {},
  { customerId = "", extra = {}, headers = {} }: {
    customerId?: string;
    extra?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Request {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      if (typeof one === "string") body.append(key, one);
      else body.append(key, one, (one as File).name ?? "upload");
    }
  }
  return appProxyRequest(path, { shop, customerId, extra, init: { method: "POST", body, headers } });
}

/** A 1×1 PNG (Rails test/fixtures/files/repair.png stand-in). */
export function pngFile(name = "repair.png"): File {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  return new File([bytes], name, { type: "image/png" });
}

/** A purchase-history GraphQL order (PURCHASE_HISTORY_QUERY shape). */
export function historyOrder({
  id,
  name,
  processedAt = "2026-01-01T00:00:00Z",
  lines,
}: {
  id: string;
  name: string;
  processedAt?: string;
  lines: {
    id: string;
    productId?: string;
    productTitle?: string;
    variantId?: string;
    variantTitle?: string;
    imageUrl?: string | null;
  }[];
}) {
  return {
    id: `gid://shopify/Order/${id}`,
    name,
    processedAt,
    lineItems: {
      nodes: lines.map((line) => ({
        id: `gid://shopify/LineItem/${line.id}`,
        image: line.imageUrl ? { url: line.imageUrl } : null,
        variant: {
          id: `gid://shopify/ProductVariant/${line.variantId ?? `${line.id}0`}`,
          title: line.variantTitle ?? "Default Title",
          media: { nodes: [] },
          product: {
            id: `gid://shopify/Product/${line.productId ?? line.id}`,
            title: line.productTitle ?? "Aria Boot",
            featuredMedia: null,
          },
        },
      })),
    },
  };
}

/** FakeGraphql responses for a customer's purchase history. */
export function purchaseHistory(orders: ReturnType<typeof historyOrder>[]) {
  return { "customer(id:": { customer: { orders: { nodes: orders } } } };
}
