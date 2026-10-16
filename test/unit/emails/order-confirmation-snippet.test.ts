/**
 * The Order confirmation snippet merchants paste into Shopify's notification
 * template, rendered with liquidjs against representative order data: a
 * repair order, a Care order, an ordinary order.
 */
import { describe, expect, it } from "vitest";
import {
  ORDER_CONFIRMATION_SNIPPET,
  previewOrders,
  renderOrderConfirmationSnippet,
  type OrderConfirmationData,
} from "../../../app/services/emails/order-confirmation.server";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const repairOrder = (attributes: Record<string, string>): OrderConfirmationData => ({
  created_at: "2026-10-16T10:00:00Z",
  attributes: { repair_quotation_id: "9", repair_ticket_id: "42", ...attributes },
  line_items: [{ title: "Resole", variant_id: 900, properties: {} }],
});

const SLIP = "https://acme.myshopify.com/apps/repairs/tickets/42/postage-slip?expires=1793000000&token=abc";

describe("order confirmation snippet", () => {
  it("shows nothing on an ordinary order", async () => {
    const html = await renderOrderConfirmationSnippet({
      created_at: "2026-10-16T10:00:00Z",
      attributes: { "gift-note": "Happy birthday" },
      line_items: [
        { title: "Chelsea Boot - 8", variant_id: 100, properties: {} },
        { title: "Engraved", variant_id: 101, properties: { Engraving: "AS" } },
      ],
    });
    expect(html.trim()).toBe("");
  });

  it("a repair order: postage slip link, workshop address, instructions, ticket number and status page", async () => {
    const html = await renderOrderConfirmationSnippet(
      repairOrder({
        shopcare_postage_slip_url: SLIP,
        shopcare_workshop_address: "Acme Repairs\n4 Cobbler's Yard\nNorthampton NN1 1AA\nUnited Kingdom",
        shopcare_posting_instructions: "Use a tracked service.",
        shopcare_status_url: "https://acme.example/pages/repairs",
      }),
    );
    expect(html).toContain(`<a href="${SLIP}"`);
    expect(html).toContain('<a href="https://acme.example/pages/repairs">Follow your repair</a>');
    expect(html).toContain("Acme Repairs<br />\n4 Cobbler&#39;s Yard<br />");
    expect(text(html)).toBe(
      "Your repair #42 Please send your item to us so we can repair it. Print the postage slip, stick the address " +
        "label on the parcel and put the packing slip inside. Download your postage slip Send it to Acme Repairs " +
        "4 Cobbler&#39;s Yard Northampton NN1 1AA United Kingdom Use a tracked service. Write your repair number, " +
        "#42, on the parcel if you can't print the slip. Follow your repair",
    );
  });

  it("a repair order for an item the workshop already has", async () => {
    const html = await renderOrderConfirmationSnippet(repairOrder({ shopcare_item_received: "yes" }));
    expect(text(html)).toBe("Your repair #42 We already have your item, so we'll start the repair now.");
  });

  it("a repair order without a workshop address says the shop will be in touch", async () => {
    const html = await renderOrderConfirmationSnippet(repairOrder({}));
    expect(text(html)).toBe(
      "Your repair #42 We'll be in touch soon about sending your item to us. Your repair number is #42.",
    );
    expect(html).not.toContain("postage slip");
  });

  it("escapes what the merchant typed", async () => {
    const html = await renderOrderConfirmationSnippet(
      repairOrder({
        shopcare_postage_slip_url: SLIP,
        shopcare_workshop_address: "<b>Acme</b>",
        shopcare_posting_instructions: "<script>x</script>",
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
  });

  it("a Care plan bought with the product: term, product and end date from the order date", async () => {
    const html = await renderOrderConfirmationSnippet({
      created_at: "2026-10-16T10:00:00Z",
      attributes: {},
      line_items: [
        { title: "Chelsea Boot - 8", variant_id: 100, product: { title: "Chelsea Boot" }, properties: {} },
        { title: "ShopCare 2-year plan", variant_id: 7001, properties: { _shopcare_for: "100", _shopcare_term_months: "24" } },
      ],
    });
    expect(text(html)).toBe(
      "ShopCare 2-year plan Your ShopCare 2 year plan covers all repairs to your Chelsea Boot until 16 October 2028, " +
        "except the exclusions in the plan's terms. To use it, ask us for a repair from our website. " +
        "This plan is in addition to, and does not affect, your statutory rights.",
    );
  });

  it("an 18-month plan crosses the year boundary", async () => {
    const html = await renderOrderConfirmationSnippet({
      created_at: "2026-10-16T10:00:00Z",
      attributes: {},
      line_items: [
        { title: "Boot", variant_id: 100, properties: {} },
        { title: "Care", variant_id: 7001, properties: { _shopcare_for: "100", _shopcare_term_months: "18" } },
      ],
    });
    expect(text(html)).toContain("Your ShopCare 18 month plan covers all repairs to your Boot until 16 April 2028,");
  });

  it("Care added later to an earlier purchase runs from that purchase (the line carries the end date)", async () => {
    const html = await renderOrderConfirmationSnippet({
      created_at: "2026-10-16T10:00:00Z",
      attributes: {},
      line_items: [
        {
          title: "ShopCare 2-year plan",
          variant_id: 7001,
          properties: {
            _shopcare_item: "3",
            Product: "Aria Boot",
            _shopcare_term_months: "24",
            _shopcare_cover_ends: "2028-10-02",
          },
        },
      ],
    });
    expect(text(html)).toContain("Your ShopCare 2 year plan covers all repairs to your Aria Boot until 2 October 2028");
  });

  it("a Care line from an older theme (no term) still gets the section, without dates", async () => {
    const html = await renderOrderConfirmationSnippet({
      created_at: "2026-10-16T10:00:00Z",
      attributes: {},
      line_items: [
        { title: "Boot", variant_id: 100, properties: {} },
        { title: "Care", variant_id: 7001, properties: { _shopcare_for: "100" } },
      ],
    });
    expect(text(html)).toContain("Your ShopCare plan covers all repairs to your Boot, except");
  });

  it("is plain Shopify notification Liquid: no app-only tags", () => {
    expect(ORDER_CONFIRMATION_SNIPPET).not.toMatch(/\{%-?\s*(render|include|section|schema)\b/);
    expect(ORDER_CONFIRMATION_SNIPPET).toContain("attributes.repair_ticket_id");
  });

  it("the Settings preview renders both sample orders", async () => {
    const shop = {
      shopifyDomain: "acme.myshopify.com",
      settings: {
        workshop_address: { name: "Acme Repairs", line1: "1 Yard", city: "Leeds", postcode: "LS1 1AA", country: "UK" },
      },
    };
    const orders = previewOrders(shop, new Date(Date.UTC(2026, 9, 16)));
    expect(text(await renderOrderConfirmationSnippet(orders.repair))).toContain("Your repair #1042");
    expect(text(await renderOrderConfirmationSnippet(orders.repair))).toContain("Acme Repairs 1 Yard Leeds LS1 1AA UK");
    expect(text(await renderOrderConfirmationSnippet(orders.care))).toContain("until 16 October 2028");
  });
});
