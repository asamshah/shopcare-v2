/**
 * Settings → save (Rails SettingsController#update / #klaviyo_test), plus the
 * v2 settings.notifications keys (Flow on/off, status page, Add Care delay).
 *
 * Specific keys are read from the form rather than mass-assigned, so values
 * are safe to merge into shop.settings. Only sections present in the form are
 * written (Care is hidden until a plan exists, Trade-in while it's parked,
 * Workshop details while parts are off), so a save never resets a section it
 * didn't show. Secrets (Klaviyo key, webhook signing secret) are encrypted
 * columns and never sent back to the browser: blank keeps the stored one.
 */
import { randomBytes } from "node:crypto";
import type { Prisma, Shop } from "@prisma/client";
import { z } from "zod";
import prisma from "../../db.server";
import { castBoolean } from "../../lib/inflections";
import {
  settingsOf,
  shopSecret,
  shopSecretData,
  tradeInEnabled,
  WORKSHOP_ADDRESS_FIELDS,
} from "../../models/shop.server";
import { d, jsonObject } from "../../models/validation.server";
import { KlaviyoClient } from "../notifications/klaviyo-client.server";
import { permittedWebhookUrl } from "../repairs/webhook-delivery.server";
import { bool, field, type Form, has } from "./form.server";

export interface SettingsDeps {
  permittedWebhookUrl: (url: string) => Promise<boolean>;
  klaviyoFetch: typeof fetch;
}

export const settingsDeps: SettingsDeps = {
  permittedWebhookUrl: (url) => permittedWebhookUrl(url),
  klaviyoFetch: (...args) => fetch(...args),
};

const oneOf = <T extends string>(value: string, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

const clampInt = (value: string, min: number, max: number) => {
  const n = parseInt(value, 10);
  return Math.min(Math.max(Number.isNaN(n) ? 0 : n, min), max);
};

const zUrlOrBlank = z.union([z.literal(""), z.string().url().max(2000)]);

export type SaveResult = { ok: true } | { ok: false; alert: string };

export async function saveSettings(
  shop: Shop,
  form: Form,
  deps: SettingsDeps = settingsDeps,
): Promise<SaveResult> {
  const current = settingsOf(shop);
  const next: Record<string, unknown> = { ...current };

  if (has(form, "webhook_url")) {
    const url = field(form, "webhook_url").trim();
    if (url && (!zUrlOrBlank.safeParse(url).success || !(await deps.permittedWebhookUrl(url)))) {
      return { ok: false, alert: "Webhook URL must be a public https:// address." };
    }
  }

  if (has(form, "repair_products[mode]")) {
    next.repair_products = {
      mode: oneOf(field(form, "repair_products[mode]"), ["tag", "collection"], "tag"),
      tag: field(form, "repair_products[tag]").trim().slice(0, 255),
      // The resource picker sends a numeric id; a pasted GID works too.
      collection_id: field(form, "repair_products[collection_id]").trim().match(/\d+$/)?.[0] ?? "",
      collection_title: field(form, "repair_products[collection_title]").trim().slice(0, 255),
    };
  }
  for (const key of ["repair_order_tag", "currency", "webhook_url"]) {
    if (has(form, key)) next[key] = field(form, key).trim().slice(0, key === "webhook_url" ? 2000 : 64);
  }
  if (typeof next.currency === "string") next.currency = next.currency.toUpperCase();
  if (has(form, "quote_valid_days")) {
    next.quote_valid_days = String(clampInt(field(form, "quote_valid_days"), 1, 90));
  }
  if (has(form, "awaiting_item_days")) {
    next.awaiting_item_days = String(clampInt(field(form, "awaiting_item_days"), 1, 365));
  }
  if (has(form, "email[subject]") || has(form, "email[body]")) {
    next.email = {
      subject: field(form, "email[subject]").slice(0, 255),
      body: field(form, "email[body]").slice(0, 5000),
    };
  }
  // Where customers post their items (postage slips).
  if (has(form, "workshop_address[name]")) {
    next.workshop_address = Object.fromEntries(
      WORKSHOP_ADDRESS_FIELDS.map((key) => [key, field(form, `workshop_address[${key}]`).trim().slice(0, 255)]),
    );
  }
  if (has(form, "posting_instructions")) {
    next.posting_instructions = field(form, "posting_instructions").trim().slice(0, 2000);
  }
  if (has(form, "parts_enabled")) next.parts_enabled = bool(form, "parts_enabled");
  if (has(form, "parts[labour_rate]")) {
    const rate = d(field(form, "parts[labour_rate]").trim() || "0");
    next.parts = {
      ...jsonObject(current.parts as Prisma.JsonValue),
      size_option: field(form, "parts[size_option]").trim().slice(0, 255),
      colour_option: field(form, "parts[colour_option]").trim().slice(0, 255),
      model_metafield: field(form, "parts[model_metafield]").trim().slice(0, 255),
      labour_rate: (rate.isNegative() ? d(0) : rate).toString(),
    };
  }
  if (has(form, "care[refund_action]")) {
    next.care = {
      refund_action: oneOf(field(form, "care[refund_action]"), ["refund", "credit", "manual"], "refund"),
      credit_scope: oneOf(field(form, "care[credit_scope]"), ["care", "store"], "care"),
      credit_days: String(clampInt(field(form, "care[credit_days]"), 0, 365)),
      add_later_url: field(form, "care[add_later_url]").trim().slice(0, 2000),
    };
  }
  // Only while trade-in is on (the section isn't shown otherwise).
  if (tradeInEnabled(shop) && has(form, "trade_in[credit_method]")) {
    next.trade_in = {
      credit_method: oneOf(field(form, "trade_in[credit_method]"), ["store_credit", "discount_code"], "store_credit"),
      credit_days: String(clampInt(field(form, "trade_in[credit_days]"), 0, 3650)),
    };
  }

  const notifications = readNotifications(form, jsonObject(current.notifications as Prisma.JsonValue));
  if ("alert" in notifications) return { ok: false, alert: notifications.alert };
  if (notifications.changed) next.notifications = notifications.value;

  const secrets: Record<string, string | null> = {};
  // Klaviyo: blank keeps the saved key, "remove" clears it.
  if (field(form, "klaviyo_remove") === "1") Object.assign(secrets, shopSecretData("klaviyoApiKey", null));
  else if (field(form, "klaviyo_api_key").trim()) {
    Object.assign(secrets, shopSecretData("klaviyoApiKey", field(form, "klaviyo_api_key").trim()));
  }
  // The signing secret is never echoed back, so blank keeps it, unless the URL was cleared.
  if (has(form, "webhook_url")) {
    const secret = field(form, "webhook_secret").trim();
    if (!field(form, "webhook_url").trim()) Object.assign(secrets, shopSecretData("webhookSecret", null));
    else if (secret) Object.assign(secrets, shopSecretData("webhookSecret", secret));
  }

  await prisma.shop.update({
    where: { id: shop.id },
    data: { settings: next as Prisma.InputJsonValue, ...secrets },
  });
  return { ok: true };
}

/** settings.notifications: flow, care_offer_delay_days, status_url. */
function readNotifications(
  form: Form,
  current: Record<string, unknown>,
): { changed: boolean; value: Record<string, unknown> } | { alert: string } {
  const value = { ...current };
  let changed = false;
  if (has(form, "notifications[flow]")) {
    value.flow = castBoolean(field(form, "notifications[flow]"));
    changed = true;
  }
  if (has(form, "notifications[care_offer_delay_days]")) {
    const raw = field(form, "notifications[care_offer_delay_days]").trim();
    const days = Number(raw);
    if (raw === "") delete value.care_offer_delay_days;
    else if (!Number.isInteger(days) || days < 1 || days > 365)
      return { alert: "Send the Add Care offer after must be a whole number of days (1 to 365)." };
    else value.care_offer_delay_days = days;
    changed = true;
  }
  if (has(form, "notifications[status_url]")) {
    const url = field(form, "notifications[status_url]").trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) return { alert: "Repair status page must be a full web address (https://…)." };
    value.status_url = url;
    changed = true;
  }
  return { changed, value };
}

/** Settings → "Send test": a Klaviyo event the merchant can see arrive (Metrics → "ShopCare Test"). */
export async function sendKlaviyoTest(
  shop: Shop,
  email: string,
  deps: SettingsDeps = settingsDeps,
): Promise<{ notice: string } | { alert: string }> {
  const key = shopSecret(shop, "klaviyoApiKey");
  if (!key) return { alert: "Add your Klaviyo private API key first." };
  const to = z.string().email().safeParse(email.trim()).success ? email.trim() : "test@example.com";
  try {
    await new KlaviyoClient(key, deps.klaviyoFetch).track({
      metric: "ShopCare Test",
      email: to,
      properties: { Shop: shop.shopifyDomain },
      uniqueId: `shopcare-test-${randomBytes(6).toString("hex")}`,
    });
    return { notice: `Test event sent to Klaviyo for ${to}.` };
  } catch (error) {
    return { alert: `Klaviyo didn't accept the test event: ${(error as Error).message}` };
  }
}

/** Is a secret stored (shown as "saved — leave blank to keep", never the value)? */
export const hasSecret = (shop: Shop, field: "klaviyoApiKey" | "webhookSecret") =>
  Boolean(shop[field === "klaviyoApiKey" ? "klaviyoApiKeyCiphertext" : "webhookSecretCiphertext"]);

