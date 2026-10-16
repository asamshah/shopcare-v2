/**
 * Settings: Rails admin_smoke_test.rb (settings half), the settings tests in
 * admin_quotes/admin_parts/care_plans/trade_ins_test.rb, plus the v2
 * notification settings.
 */
import type { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../app/db.server";
import {
  careSettings,
  completeWorkshopAddress,
  DEFAULT_POSTING_INSTRUCTIONS,
  postingInstructions,
  labourRate,
  careOfferDelayDays,
  notificationsSettings,
  repairStatusUrl,
  partsEnabled,
  partsSettings,
  quoteValidDays,
  settingsOf,
  shopSecret,
  shopSecretData,
  tradeInSettings,
} from "../../../app/models/shop.server";
import { loader, action } from "../../../app/routes/app.settings";
import { settingsDeps } from "../../../app/services/admin/settings.server";
import { checkWebhookUrl } from "../../../app/services/repairs/webhook-delivery.server";
import { loadNotificationSettings } from "../../../app/services/notifications/shop-settings.server";
import { flash, get, post, signInAs, type FormFields } from "../../support/admin";
import { createCarePlanFor, createNotificationDeliveryFor, createShop } from "../../support/factories";

type Data = Awaited<ReturnType<typeof loader>>;

async function setup(settings: Record<string, unknown> = { currency: "GBP" }, extra = {}) {
  const shop = await createShop({
    shopifyDomain: "admin-settings.myshopify.com",
    settings: settings as Prisma.InputJsonValue,
    ...extra,
  });
  signInAs(shop);
  return shop;
}

const save = (fields: FormFields) => post(action, "/app/settings", { intent: "save", ...fields });
const reload = (id: number) => prisma.shop.findUniqueOrThrow({ where: { id } });
const show = () => get<Data>(loader, "/app/settings");

const original = { ...settingsDeps };
afterEach(() => Object.assign(settingsDeps, original));

describe("settings", () => {
  it("saves the repair-product config and quote email", async () => {
    const shop = await setup();
    const res = await save({
      "repair_products[mode]": "tag",
      "repair_products[tag]": "repair",
      currency: "GBP",
      "email[subject]": "Hi",
      "email[body]": "Body",
    });
    expect(flash(res)).toEqual({ path: "/app/settings", notice: "Settings saved." });
    const settings = settingsOf(await reload(shop.id));
    expect(settings.repair_products).toMatchObject({ mode: "tag", tag: "repair" });
    expect(settings.email).toEqual({ subject: "Hi", body: "Body" });
  });

  it("rejects a private webhook url (strict, as in production)", async () => {
    const shop = await setup();
    settingsDeps.permittedWebhookUrl = async (url) => (await checkWebhookUrl(url, { strict: true })).ok;
    const res = await save({ webhook_url: "https://169.254.169.254/x" });
    expect(flash(res).alert).toBe("Webhook URL must be a public https:// address.");
    expect(settingsOf(await reload(shop.id)).webhook_url).toBeUndefined();
    expect(flash(await save({ webhook_url: "javascript:alert(1)" })).alert).toBe(
      "Webhook URL must be a public https:// address.",
    );
  });

  it("keeps the stored webhook secret when the field is left blank; clearing the URL clears it", async () => {
    const shop = await setup({ webhook_url: "https://example.com/h" }, shopSecretData("webhookSecret", "keepme"));
    await save({ webhook_url: "https://example.com/h", webhook_secret: "" });
    expect(shopSecret(await reload(shop.id), "webhookSecret")).toBe("keepme");
    await save({ webhook_url: "https://example.com/h", webhook_secret: "newsecret" });
    expect(shopSecret(await reload(shop.id), "webhookSecret")).toBe("newsecret");
    await save({ webhook_url: "", webhook_secret: "" });
    expect(shopSecret(await reload(shop.id), "webhookSecret")).toBeNull();
  });

  it("never sends stored secrets to the browser", async () => {
    await setup(
      { webhook_url: "https://example.com/h" },
      { ...shopSecretData("webhookSecret", "topsecret123"), ...shopSecretData("klaviyoApiKey", "pk_live_secret") },
    );
    const data = await show();
    const json = JSON.stringify(data);
    expect(json).not.toMatch(/topsecret123|pk_live_secret/);
    expect([data.hasWebhookSecret, data.hasKlaviyoKey]).toEqual([true, true]);
  });

  it("collection id accepts a pasted GID", async () => {
    const shop = await setup();
    await save({ "repair_products[mode]": "collection", "repair_products[collection_id]": "gid://shopify/Collection/555" });
    expect(settingsOf(await reload(shop.id)).repair_products).toMatchObject({ collection_id: "555" });
  });

  it("shows Care once a plan exists, workshop details once tracked, trade-in only when on", async () => {
    const shop = await setup();
    let data = await show();
    expect([data.care, data.tradeIn, data.partsEnabled]).toEqual([null, null, false]);

    await prisma.shop.update({ where: { id: shop.id }, data: { settings: { parts_enabled: true } } });
    data = await show();
    expect(data.partsEnabled).toBe(true);
    expect(data.parts.labour_rate).toBe("0");

    await createCarePlanFor(shop);
    expect((await show()).care?.refund_action).toBe("refund");
  });

  it("a save only writes the sections the form showed", async () => {
    const shop = await setup(
      { care: { refund_action: "credit" }, parts: { labour_rate: "30.0" }, webhook_url: "https://example.com/h" },
      shopSecretData("webhookSecret", "keep"),
    );
    await save({
      currency: "EUR",
      "repair_products[mode]": "collection",
      "repair_products[collection_id]": "55",
      "repair_products[collection_title]": "Repairs",
    });
    const updated = await reload(shop.id);
    const settings = settingsOf(updated);
    expect([settings.currency, careSettings(updated).refund_action, partsSettings(updated).labour_rate]).toEqual([
      "EUR", "credit", "30.0",
    ]);
    expect(shopSecret(updated, "webhookSecret")).toBe("keep");
    expect(settings.repair_products).toEqual({ mode: "collection", tag: "", collection_id: "55", collection_title: "Repairs" });
  });

  it("the quote validity is a Repairs setting, clamped to 1–90 days", async () => {
    const shop = await setup();
    await save({ quote_valid_days: "21" });
    expect(quoteValidDays(await reload(shop.id))).toBe(21);
    await save({ quote_valid_days: "0" });
    expect(quoteValidDays(await reload(shop.id))).toBe(1);
    await save({ quote_valid_days: "500" });
    expect(quoteValidDays(await reload(shop.id))).toBe(90);
  });

  it("saves the parts mapping and labour rate, and the switch turns parts on and off", async () => {
    const shop = await setup({ parts_enabled: true });
    await save({
      "parts[size_option]": "Shoe size",
      "parts[colour_option]": "",
      "parts[model_metafield]": "footwear.sole",
      "parts[labour_rate]": "35",
    });
    let updated = await reload(shop.id);
    const parts = partsSettings(updated);
    expect([parts.size_option, parts.colour_option, parts.model_metafield]).toEqual([
      "Shoe size", "Color, Colour", "footwear.sole",
    ]);
    expect(labourRate(updated).toNumber()).toBe(35);

    await save({ parts_enabled: ["0"] });
    expect(partsEnabled(await reload(shop.id))).toBe(false);
    await save({ parts_enabled: ["0", "1"] });
    updated = await reload(shop.id);
    expect(partsEnabled(updated)).toBe(true);
  });

  it("saves Care refund behaviour and connects, keeps, tests and removes Klaviyo", async () => {
    const shop = await setup();
    await save({
      "care[refund_action]": "credit",
      "care[credit_scope]": "store",
      "care[credit_days]": "60",
      "care[add_later_url]": "https://shop.test/pages/care",
      "notifications[flow]": "0",
      klaviyo_api_key: "pk_live",
    });
    let updated = await reload(shop.id);
    expect([careSettings(updated).refund_action, careSettings(updated).credit_scope, careSettings(updated).credit_days]).toEqual([
      "credit", "store", "60",
    ]);
    expect(notificationsSettings(updated).flow).toBe(false);
    expect(shopSecret(updated, "klaviyoApiKey")).toBe("pk_live");

    await save({ klaviyo_api_key: "" });
    expect(shopSecret(await reload(shop.id), "klaviyoApiKey")).toBe("pk_live");

    const fetchSpy = vi.fn(async () => new Response("", { status: 202 }));
    settingsDeps.klaviyoFetch = fetchSpy as unknown as typeof fetch;
    const res = await post(action, "/app/settings", { intent: "klaviyo_test", email: "me@shop.test" });
    expect(flash(res).notice).toBe("Test event sent to Klaviyo for me@shop.test.");
    expect(fetchSpy).toHaveBeenCalledOnce();

    settingsDeps.klaviyoFetch = (async () => new Response("bad key", { status: 401 })) as typeof fetch;
    expect(flash(await post(action, "/app/settings", { intent: "klaviyo_test", email: "me@shop.test" })).alert).toMatch(
      /^Klaviyo didn't accept the test event: Klaviyo 401/,
    );

    await save({ klaviyo_remove: "1" });
    updated = await reload(shop.id);
    expect(shopSecret(updated, "klaviyoApiKey")).toBeNull();
    expect(flash(await post(action, "/app/settings", { intent: "klaviyo_test" })).alert).toBe(
      "Add your Klaviyo private API key first.",
    );
  });

  it("with trade-in off, a save keeps stored trade-in settings; with it on, they're saved", async () => {
    const shop = await setup({ trade_in: { credit_method: "discount_code" } });
    await save({ currency: "GBP", "trade_in[credit_method]": "store_credit" });
    expect(tradeInSettings(await reload(shop.id)).credit_method).toBe("discount_code");

    await prisma.shop.update({ where: { id: shop.id }, data: { settings: { trade_in_enabled: true } } });
    await save({ "trade_in[credit_method]": "discount_code", "trade_in[credit_days]": "90" });
    const settings = tradeInSettings(await reload(shop.id));
    expect([settings.credit_method, settings.credit_days]).toEqual(["discount_code", "90"]);
    expect((await show()).tradeIn?.credit_days).toBe("90");
  });

  it("Shopify Flow is off by default and can be switched on; there are no ShopCare email settings", async () => {
    const shop = await setup();
    expect((await show()).notifications.flow).toBe(false);
    expect((await loadNotificationSettings(shop.shopifyDomain))?.flowEnabled).toBe(false);

    await save({ "notifications[flow]": ["0", "1"] });
    expect((await loadNotificationSettings(shop.shopifyDomain))?.flowEnabled).toBe(true);
    expect((await show()).notifications.flow).toBe(true);

    // Old email fields are ignored.
    await save({ "notifications[staff_email]": "workshop@shop.test", "notifications[emails][care_offer][enabled]": "1" });
    expect(notificationsSettings(await reload(shop.id))).not.toHaveProperty("staff_email");
    expect(notificationsSettings(await reload(shop.id))).not.toHaveProperty("emails");
  });

  it("Add Care offer delay and the repair status page", async () => {
    const shop = await setup();
    expect((await show()).notifications).toMatchObject({ careOfferDelayDays: "7", statusUrl: "" });

    await save({
      "notifications[care_offer_delay_days]": "14",
      "notifications[status_url]": "https://shop.test/pages/repair-status",
    });
    const saved = await reload(shop.id);
    expect(careOfferDelayDays(saved)).toBe(14);
    expect(repairStatusUrl(saved)).toBe("https://shop.test/pages/repair-status");
    expect((await show()).notifications).toMatchObject({ careOfferDelayDays: "14" });

    expect(flash(await save({ "notifications[care_offer_delay_days]": "0" })).alert).toBe(
      "Send the Add Care offer after must be a whole number of days (1 to 365).",
    );
    expect(flash(await save({ "notifications[status_url]": "javascript:alert(1)" })).alert).toBe(
      "Repair status page must be a full web address (https://…).",
    );
    expect(careOfferDelayDays(await reload(shop.id))).toBe(14);

    await save({ "notifications[care_offer_delay_days]": "", "notifications[status_url]": "" });
    expect([careOfferDelayDays(await reload(shop.id)), repairStatusUrl(await reload(shop.id))]).toEqual([7, null]);
  });

  it("lists this shop's recent notifications only", async () => {
    const shop = await setup();
    const other = await createShop();
    await createNotificationDeliveryFor(shop, { status: "failed", error: "Klaviyo 401", channel: "klaviyo" });
    await createNotificationDeliveryFor(other, { status: "sent" });
    const data = await show();
    expect(data.deliveries.map((d) => [d.channel, d.statusLabel, d.error])).toEqual([["Klaviyo", "Failed", "Klaviyo 401"]]);
  });

  it("saves the workshop address and posting instructions, and says when the address is incomplete", async () => {
    const shop = await setup();
    let data = await show();
    expect(data.workshopAddressComplete).toBe(false);
    expect(data.workshopAddress).toEqual({ name: "", line1: "", line2: "", city: "", postcode: "", country: "" });

    const res = await save({
      "workshop_address[name]": " Acme Repairs ",
      "workshop_address[line1]": "4 Cobbler's Yard",
      "workshop_address[line2]": "",
      "workshop_address[city]": "Northampton",
      "workshop_address[postcode]": "NN1 1AA",
      "workshop_address[country]": "United Kingdom",
      posting_instructions: "Use Royal Mail Tracked 48.",
    });
    expect(flash(res).notice).toBe("Settings saved.");
    const saved = await reload(shop.id);
    expect(completeWorkshopAddress(saved)).toEqual({
      name: "Acme Repairs", line1: "4 Cobbler's Yard", line2: "", city: "Northampton", postcode: "NN1 1AA", country: "United Kingdom",
    });
    expect(postingInstructions(saved)).toBe("Use Royal Mail Tracked 48.");
    data = await show();
    expect(data.workshopAddressComplete).toBe(true);

    // A blank instruction falls back to the default; a missing postcode makes the address incomplete.
    await save({ "workshop_address[name]": "Acme Repairs", "workshop_address[line1]": "4 Cobbler's Yard", posting_instructions: "" });
    const partial = await reload(shop.id);
    expect(completeWorkshopAddress(partial)).toBeNull();
    expect(postingInstructions(partial)).toBe(DEFAULT_POSTING_INSTRUCTIONS);
    expect((await show()).workshopAddressComplete).toBe(false);
  });
});
