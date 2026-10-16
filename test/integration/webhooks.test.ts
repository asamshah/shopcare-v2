import { afterEach, describe, expect, it, vi } from "vitest";
import { action } from "../../app/routes/webhooks.orders.paid";
import { webhookRequest } from "../support/shopify-requests";

const run = (request: Request) =>
  action({ request, params: {}, context: {} } as Parameters<typeof action>[0]);

describe("POST /webhooks/orders/paid", () => {
  afterEach(() => vi.restoreAllMocks());

  it("acks a valid delivery and hands it to the webhook job", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await run(
      webhookRequest("/webhooks/orders/paid", {
        topic: "orders/paid",
        shop: "acme.myshopify.com",
        payload: { id: 1 },
      }),
    );

    expect(response.status).toBe(200);
    // BACKGROUND_DISPATCH=sync in tests, so the job has already run.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "ORDERS_PAID for acme.myshopify.com: no handler ported yet",
      ),
    );
  });

  it("rejects a delivery with a bad HMAC", async () => {
    const request = webhookRequest("/webhooks/orders/paid", {
      topic: "orders/paid",
      shop: "acme.myshopify.com",
      payload: { id: 1 },
    });
    request.headers.set("x-shopify-hmac-sha256", "bm9wZQ==");
    await expect(run(request)).rejects.toMatchObject({ status: 401 });
  });
});
