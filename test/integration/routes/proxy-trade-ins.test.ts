/**
 * Port of the storefront half of "with the flag off, trade-in is hidden from
 * the admin and the storefront" (Rails test/integration/trade_ins_test.rb).
 * Trade-in is parked for V2; the flag-on storefront tests wait for
 * w2-backend's TradeIns::Quoter / Submission port (see
 * app/services/storefront/trade-ins.server.ts).
 */
import type { Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import { loader as options } from "../../../app/routes/proxy.trade_in_options";
import { action as create } from "../../../app/routes/proxy.trade_ins";
import { createItemFor } from "../../support/factories";
import {
  fakeStorefront,
  installedShop,
  runRoute,
  signedGet,
  signedPost,
  type StorefrontFakes,
} from "../../support/proxy-routes";

const domain = "tradein-admin.myshopify.com";

describe("trade-in on the storefront (parked)", () => {
  let shop: Shop;
  let fakes: StorefrontFakes;

  beforeEach(async () => {
    shop = await installedShop(domain, { settings: { currency: "GBP" } });
    fakes = fakeStorefront();
  });
  afterEach(() => fakes.restore());

  it("with the flag off, both endpoints answer 'not available'", async () => {
    const item = await createItemFor(shop, { shopifyCustomerId: "77" });

    const get = await runRoute(options, signedGet("/proxy/trade_in_options", domain, { customerId: "77" }));
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ ok: false, available: false, errors: ["Trade-in isn't available."] });

    const post = await runRoute(
      create,
      signedPost("/proxy/trade_ins", domain, { source: "form", item_id: String(item.id), grade: "good" }, { customerId: "77" }),
    );
    expect(post.status).toBe(404);
    expect(await prisma.tradeIn.count()).toBe(0);
  });
});
