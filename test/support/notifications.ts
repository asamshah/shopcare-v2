/**
 * Builders for notification tests: shop settings and a NotificationDeps
 * bundle with in-memory fakes (Flow through a FakeGraphql, Klaviyo through a
 * fake fetch).
 */
import { vi } from "vitest";
import type { NotificationDeps } from "../../app/services/notifications.server";
import type { ShopNotificationSettings } from "../../app/services/notifications/settings.server";
import { InMemoryNotificationStore } from "../../app/services/notifications/store.server";
import { FakeGraphql } from "./fake-graphql";

export function buildSettings(
  overrides: Partial<ShopNotificationSettings> = {},
): ShopNotificationSettings {
  return {
    shopId: "acme.myshopify.com",
    flowEnabled: false,
    klaviyoApiKey: null,
    ...overrides,
  };
}

export function buildDeps(overrides: Partial<NotificationDeps> = {}) {
  const store = new InMemoryNotificationStore();
  const graphql = new FakeGraphql({
    flowTriggerReceive: { flowTriggerReceive: { userErrors: [] } },
  });
  const settings = { current: buildSettings() };
  const enqueued: string[] = [];
  const deps = {
    store,
    loadSettings: vi.fn(async () => settings.current),
    adminClient: vi.fn(async () => graphql),
    enqueue: vi.fn(async (_job: "notification", { deliveryId }) => {
      enqueued.push(deliveryId);
    }),
    fetch: vi.fn(
      async () => new Response("", { status: 202 }),
    ) as unknown as typeof fetch,
    ...overrides,
  } satisfies NotificationDeps;
  return { deps, store, graphql, settings, enqueued };
}
