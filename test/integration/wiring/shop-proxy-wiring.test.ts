/**
 * The App Proxy's production wiring on the Shop row: the customer signing key
 * (encrypted column, saved by ensureCustomerSigningKey through afterAuth) and
 * the remembered proxy path prefix, end to end through authenticateProxy.
 */
import { describe, expect, it, vi } from "vitest";
import prisma from "../../../app/db.server";
import { authenticateProxy, appProxyDeps } from "../../../app/lib/app-proxy.server";
import { signCustomerToken } from "../../../app/lib/customer-token.server";
import {
  customerSigningKeyFor,
  customerSigningKeyState,
  proxyPathPrefix,
  rememberProxyPathPrefix,
  shopSecret,
} from "../../../app/models/shop.server";
import { setUpShopAfterAuth } from "../../../app/services/shops/after-auth.server";
import { appProxyRequest } from "../../support/shopify-requests";
import { createSession, createShop } from "../../support/factories";
import { FakeGraphql } from "../../support/fake-graphql";

const fakeApi = (userErrors: { message: string }[] = []) =>
  new FakeGraphql({
    currentAppInstallation: { currentAppInstallation: { id: "gid://shopify/AppInstallation/9" } },
    metafieldsSet: { metafieldsSet: { metafields: [], userErrors } },
  });

describe("afterAuth: shop row + customer signing key", () => {
  it("creates the shop, stores the key encrypted and records the publish", async () => {
    const api = fakeApi();
    await setUpShopAfterAuth("acme.myshopify.com", api);

    const shop = await prisma.shop.findUniqueOrThrow({ where: { shopifyDomain: "acme.myshopify.com" } });
    const key = shopSecret(shop, "customerSigningKey");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(shop.customerSigningKeyCiphertext).not.toContain(key!);
    expect(customerSigningKeyState(shop).publishedAt).toBeTruthy();
    const published = api.calls.find((c) => c.query.includes("metafieldsSet"))!;
    expect((published.variables.metafields as { value: string }[])[0].value).toBe(key);

    // A second login changes nothing.
    await setUpShopAfterAuth("acme.myshopify.com", fakeApi());
    const again = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect(shopSecret(again, "customerSigningKey")).toBe(key);
  });

  it("keeps the saved key unpublished when the publish fails, and retries it next time", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await setUpShopAfterAuth("acme.myshopify.com", fakeApi([{ message: "nope" }]));
    error.mockRestore();
    const shop = await prisma.shop.findUniqueOrThrow({ where: { shopifyDomain: "acme.myshopify.com" } });
    const state = customerSigningKeyState(shop);
    expect(state.key).toBeTruthy();
    expect(state.publishedAt).toBeNull();

    await setUpShopAfterAuth("acme.myshopify.com", fakeApi());
    const after = customerSigningKeyState(
      await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } }),
    );
    expect(after.key).toBe(state.key);
    expect(after.publishedAt).toBeTruthy();
  });

  it("marks a reinstalled shop installed again", async () => {
    await createShop({ shopifyDomain: "acme.myshopify.com", uninstalledAt: new Date() });
    await setUpShopAfterAuth("acme.myshopify.com", fakeApi());
    const shop = await prisma.shop.findUniqueOrThrow({ where: { shopifyDomain: "acme.myshopify.com" } });
    expect(shop.uninstalledAt).toBeNull();
  });
});

describe("App Proxy wiring", () => {
  it("looks the signing key up on the Shop row", async () => {
    await setUpShopAfterAuth("acme.myshopify.com", fakeApi());
    expect(await customerSigningKeyFor("acme.myshopify.com")).toMatch(/^[0-9a-f]{64}$/);
    expect(await customerSigningKeyFor("nope.myshopify.com")).toBeNull();
  });

  it("verifies a Liquid-signed customer token with the shop's key (default deps)", async () => {
    const shop = "acme.myshopify.com";
    await createSession({ shop, id: `offline_${shop}` });
    await setUpShopAfterAuth(shop, fakeApi());
    const key = (await customerSigningKeyFor(shop))!;
    const ts = String(Math.floor(Date.now() / 1000));

    const ctx = await authenticateProxy(
      appProxyRequest("/proxy/ping", {
        shop,
        extra: { customer_id: "777", customer_ts: ts, customer_sig: signCustomerToken(key, "777", ts) },
      }),
      appProxyDeps(),
    );
    expect(await ctx.currentCustomerId()).toBe("777");

    const forged = await authenticateProxy(
      appProxyRequest("/proxy/ping", {
        shop,
        extra: { customer_id: "777", customer_ts: ts, customer_sig: signCustomerToken("other", "777", ts) },
      }),
      appProxyDeps(),
    );
    expect(await forged.currentCustomerId()).toBeNull();
  });

  it("remembers a customised proxy path prefix, writing only on change", async () => {
    const shop = await createShop({ settings: { shop_name: "Acme" } });
    await rememberProxyPathPrefix(shop.shopifyDomain, "/apps/repairs");
    let row = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect(row.updatedAt).toEqual(shop.updatedAt);

    await rememberProxyPathPrefix(shop.shopifyDomain, "/community/fix");
    row = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect(proxyPathPrefix(row)).toBe("/community/fix");
    expect(row.settings).toMatchObject({ shop_name: "Acme" });

    await expect(rememberProxyPathPrefix("nope.myshopify.com", "/a/b")).resolves.toBeUndefined();
  });

  it("a signed request with a custom path_prefix updates the shop (default deps)", async () => {
    const shop = "acme.myshopify.com";
    await createSession({ shop, id: `offline_${shop}` });
    await createShop({ shopifyDomain: shop });
    await authenticateProxy(
      appProxyRequest("/proxy/ping", { shop, extra: { path_prefix: "/tools/care" } }),
      appProxyDeps(),
    );
    const row = await prisma.shop.findUniqueOrThrow({ where: { shopifyDomain: shop } });
    expect(proxyPathPrefix(row)).toBe("/tools/care");
  });
});
