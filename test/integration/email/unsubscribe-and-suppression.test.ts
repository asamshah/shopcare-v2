/**
 * The unsubscribe page, the Resend bounce/complaint webhook and the
 * suppression list behind them (v2; Rails had none of these).
 */
import { createHmac } from "node:crypto";
import type { Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../app/db.server";
import { marketingUnsubscribeJob, setMarketingUnsubscribeClient } from "../../../app/jobs/marketing-unsubscribe.server";
import { loader, action } from "../../../app/routes/email.unsubscribe";
import { productionNotificationDeps } from "../../../app/services/notifications/production-deps.server";
import { resendWebhook } from "../../../app/services/notifications/resend-webhook.server";
import { emailDigest, isEmailSuppressed } from "../../../app/services/notifications/suppressions.server";
import { unsubscribe } from "../../../app/services/notifications/unsubscribe-request.server";
import { signUnsubscribeToken } from "../../../app/services/notifications/unsubscribe.server";
import { createNotificationDeliveryFor, createShop } from "../../support/factories";
import { FakeGraphql } from "../../support/fake-graphql";

const url = (token: string) => `https://shopcare.test/email/unsubscribe?token=${token}`;

describe("unsubscribe", () => {
  let shop: Shop;
  let token: string;

  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "unsub.myshopify.com" });
    token = signUnsubscribeToken({ shop: shop.shopifyDomain, email: "A@Example.com", customerId: "77" });
  });

  it("GET only shows a confirmation form", async () => {
    const response = await loader({ request: new Request(url(token)), params: {}, context: {} } as never);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<form method="post">');
    expect(await prisma.emailSuppression.count()).toBe(0);
  });

  it("POST (one-click) records a per-shop marketing opt-out and queues the Shopify consent update", async () => {
    const enqueue = vi.fn(async () => {});
    const request = new Request(url(token), { method: "POST", body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }) });
    const response = await unsubscribe(request, { enqueue });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("re unsubscribed");
    const rows = await prisma.emailSuppression.findMany();
    expect(rows).toMatchObject([
      { shopId: shop.id, scopeKey: `shop:${shop.id}`, emailDigest: emailDigest("a@example.com"), kind: "marketing", reason: "unsubscribe" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("example.com"); // digest only
    expect(enqueue).toHaveBeenCalledWith("marketing-unsubscribe", { shop: shop.shopifyDomain, customerId: "77" });

    await unsubscribe(new Request(url(token), { method: "POST" }), { enqueue }); // repeat: no-op
    expect(await prisma.emailSuppression.count()).toBe(1);

    expect(await isEmailSuppressed(shop.shopifyDomain, "a@example.com", { marketing: true })).toBe(true);
    expect(await isEmailSuppressed(shop.shopifyDomain, "a@example.com", { marketing: false })).toBe(false);
    const other = await createShop();
    expect(await isEmailSuppressed(other.shopifyDomain, "a@example.com", { marketing: true })).toBe(false);
  });

  it("the form POST carries the token in the body", async () => {
    const request = new Request("https://shopcare.test/email/unsubscribe", {
      method: "POST",
      body: new URLSearchParams({ token }),
    });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(200);
    expect(await prisma.emailSuppression.count()).toBe(1);
  });

  it("rejects a bad token", async () => {
    const response = await unsubscribe(new Request(url(`${token}x`), { method: "POST" }), { enqueue: vi.fn() });
    expect(response.status).toBe(400);
    expect(await prisma.emailSuppression.count()).toBe(0);
  });

  it("the consent job tells Shopify the customer unsubscribed", async () => {
    const api = new FakeGraphql({
      customerEmailMarketingConsentUpdate: { customerEmailMarketingConsentUpdate: { customer: { id: "x" }, userErrors: [] } },
    });
    setMarketingUnsubscribeClient(async () => api);
    try {
      await marketingUnsubscribeJob({ shop: shop.shopifyDomain, customerId: "77" });
    } finally {
      setMarketingUnsubscribeClient(undefined);
    }
    expect(api.calls[0].variables.input).toMatchObject({
      customerId: "gid://shopify/Customer/77",
      emailMarketingConsent: { marketingState: "UNSUBSCRIBED" },
    });
  });

  it("production wiring gives marketing email an unsubscribe link and checks the list", async () => {
    const deps = productionNotificationDeps();
    const link = deps.unsubscribeUrl!(shop.shopifyDomain, { customerId: "77", email: "a@example.com" });
    expect(link).toMatch(/^https:\/\/shopcare\.test\/email\/unsubscribe\?token=/);
    expect(await deps.isSuppressed!(shop.shopifyDomain, "a@example.com", { marketing: true })).toBe(false);
  });
});

describe("Resend webhook", () => {
  const secretBytes = Buffer.from("resend-webhook-secret");
  const secret = `whsec_${secretBytes.toString("base64")}`;
  let shop: Shop;

  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "bounce.myshopify.com" });
    vi.useFakeTimers({ now: new Date("2026-10-16T12:00:00Z"), toFake: ["Date"] });
  });
  afterEach(() => vi.useRealTimers());

  const post = (event: unknown, sign = true) => {
    const body = JSON.stringify(event);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", secretBytes).update(`msg_1.${ts}.${body}`).digest("base64");
    return resendWebhook(
      new Request("https://shopcare.test/webhooks/email", {
        method: "POST",
        body,
        headers: { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": sign ? `v1,${sig}` : "v1,bm9wZQ==" },
      }),
      { secret },
    );
  };

  it("rejects an unsigned request", async () => {
    expect((await post({ type: "email.bounced" }, false)).status).toBe(401);
  });

  it("a permanent bounce suppresses the address everywhere and notes the delivery", async () => {
    const delivery = await createNotificationDeliveryFor(shop, { idempotencyKey: "k", status: "sent", providerMessageId: "em_1" });
    const response = await post({
      type: "email.bounced",
      data: { email_id: "em_1", to: ["gone@example.com"], bounce: { type: "Permanent", subType: "General", message: "No such user" } },
    });
    expect(response.status).toBe(200);
    expect(await prisma.emailSuppression.findMany()).toMatchObject([{ shopId: null, scopeKey: "global", kind: "all", reason: "bounce" }]);
    expect(await isEmailSuppressed("any-shop.myshopify.com", "gone@example.com", { marketing: false })).toBe(true);
    expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).error).toBe(
      "Bounced: General: No such user",
    );
  });

  it("ignores a transient bounce", async () => {
    await post({ type: "email.bounced", data: { to: ["full@example.com"], bounce: { type: "Transient" } } });
    expect(await prisma.emailSuppression.count()).toBe(0);
  });

  it("a complaint suppresses the address for the shop that sent it", async () => {
    await createNotificationDeliveryFor(shop, { idempotencyKey: "k", status: "sent", providerMessageId: "em_2" });
    await post({ type: "email.complained", data: { email_id: "em_2", to: ["angry@example.com"] } });
    expect(await isEmailSuppressed(shop.shopifyDomain, "angry@example.com", { marketing: false })).toBe(true);
    const other = await createShop();
    expect(await isEmailSuppressed(other.shopifyDomain, "angry@example.com", { marketing: false })).toBe(false);
  });
});
