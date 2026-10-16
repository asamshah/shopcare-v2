/**
 * Ported from Rails test/services/repairs/webhook_delivery_test.rb, plus the
 * v2 SSRF additions: every resolved address checked, connection pinned to the
 * checked address, redirects not followed.
 */
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWebhookHeaders,
  checkWebhookUrl,
  deliverWebhook,
  isInternalAddress,
  nodeTransport,
  permittedWebhookUrl,
  pinnedLookup,
  type Resolver,
  type Transport,
} from "../../../app/services/repairs/webhook-delivery.server";

const resolveTo =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));

describe("headers", () => {
  it("sets json headers, the event header and a signature", () => {
    const body = JSON.stringify({ event: "payment" });
    const headers = buildWebhookHeaders(body, {
      event: "payment",
      secret: "s3cret",
    });

    expect(headers["Content-Type"]).toBe("application/json");
    // v2 names (Rails sent Repairs-App-Webhook / X-Repairs-*).
    expect(headers["User-Agent"]).toBe("ShopCare-Webhook/1.0");
    expect(headers["X-ShopCare-Event"]).toBe("payment");
    expect(headers["X-ShopCare-Hmac-Sha256"]).toBe(
      createHmac("sha256", "s3cret").update(body).digest("hex"),
    );
  });

  it("omits the signature header when no secret is configured", () => {
    expect(
      buildWebhookHeaders("{}", { event: "submitted" }),
    ).not.toHaveProperty("X-ShopCare-Hmac-Sha256");
  });
});

describe("permitted URLs", () => {
  it("outside strict mode any http(s) url is permitted", async () => {
    const lax = { strict: false };
    expect(await permittedWebhookUrl("http://localhost:3000/hook", lax)).toBe(
      true,
    );
    expect(await permittedWebhookUrl("ftp://example.com/hook", lax)).toBe(
      false,
    );
    expect(await permittedWebhookUrl("not a url", lax)).toBe(false);
  });

  it("is strict by default outside development and test", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(await permittedWebhookUrl("http://8.8.8.8/hook")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("in strict mode only public https hosts are permitted (SSRF guard)", async () => {
    const strict = { strict: true };
    expect(
      await permittedWebhookUrl("http://8.8.8.8/hook", strict),
      "plain http",
    ).toBe(false);
    expect(
      await permittedWebhookUrl("https://127.0.0.1/hook", strict),
      "loopback",
    ).toBe(false);
    expect(
      await permittedWebhookUrl(
        "https://169.254.169.254/latest/meta-data",
        strict,
      ),
      "cloud metadata",
    ).toBe(false);
    expect(
      await permittedWebhookUrl("https://10.0.0.5/hook", strict),
      "private",
    ).toBe(false);
    expect(
      await permittedWebhookUrl("https://[::1]/hook", strict),
      "ipv6 loopback",
    ).toBe(false);
    expect(
      await permittedWebhookUrl("https://[::ffff:127.0.0.1]/hook", strict),
      "ipv4-mapped loopback",
    ).toBe(false);
    expect(await permittedWebhookUrl("https://8.8.8.8/hook", strict)).toBe(
      true,
    );
  });

  it("checks every resolved address, not just the first", async () => {
    const mixed = await checkWebhookUrl("https://hooks.example.com/x", {
      strict: true,
      resolve: resolveTo("93.184.216.34", "10.0.0.1"),
    });
    expect(mixed).toEqual({
      ok: false,
      reason: "resolves to a non-public address",
    });

    const unresolvable = await checkWebhookUrl("https://nope.invalid/x", {
      strict: true,
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(unresolvable.ok).toBe(false);

    expect(
      await checkWebhookUrl("https://hooks.example.com/x", {
        strict: true,
        resolve: resolveTo("93.184.216.34", "2606:2800:220:1::1"),
      }),
    ).toEqual({ ok: true, address: "93.184.216.34" });
  });

  it("refuses credentials in the URL", async () => {
    const result = await checkWebhookUrl(
      "https://user:pw@hooks.example.com/x",
      {
        strict: true,
        resolve: resolveTo("93.184.216.34"),
      },
    );
    expect(result.ok).toBe(false);
  });

  it.each([
    ["0.0.0.0", true],
    ["100.64.1.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["224.0.0.1", true],
    ["255.255.255.255", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["64:ff9b::a00:1", true],
    ["not-an-ip", true],
    ["8.8.8.8", false],
    ["172.32.0.1", false],
    ["2606:4700:4700::1111", false],
  ])("isInternalAddress(%s) is %s", (address, expected) => {
    expect(isInternalAddress(address)).toBe(expected);
  });
});

describe("deliverWebhook", () => {
  it("refuses a blocked url without making a request", async () => {
    const transport = vi.fn<Transport>();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      await deliverWebhook(
        "https://127.0.0.1/hook",
        { event: "x" },
        { strict: true, transport },
      ),
    ).toBeNull();
    expect(transport).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("pins the request to the address it checked", async () => {
    const transport = vi.fn<Transport>(async () => ({ status: 200 }));
    const result = await deliverWebhook(
      "https://hooks.example.com/x",
      { event: "payment" },
      {
        strict: true,
        resolve: resolveTo("93.184.216.34"),
        transport,
        secret: "s",
      },
    );

    expect(result).toEqual({ status: 200 });
    const request = transport.mock.calls[0][0];
    expect(request.address).toBe("93.184.216.34");
    expect(request.url.hostname).toBe("hooks.example.com");
    expect(request.headers["X-ShopCare-Hmac-Sha256"]).toBe(
      createHmac("sha256", "s").update(request.body).digest("hex"),
    );
  });

  it("returns null when the request fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const transport: Transport = async () => {
      throw new Error("ECONNRESET");
    };
    expect(
      await deliverWebhook(
        "https://8.8.8.8/x",
        { event: "x" },
        { strict: true, transport },
      ),
    ).toBeNull();
    error.mockRestore();
  });

  it("pinnedLookup answers with the checked address whatever the hostname", () => {
    const lookup = pinnedLookup("93.184.216.34");
    const single = vi.fn();
    lookup("evil.example", {}, single);
    expect(single).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    const all = vi.fn();
    lookup("evil.example", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [
      { address: "93.184.216.34", family: 4 },
    ]);
  });
});

describe("nodeTransport", () => {
  let server: Server | undefined;
  afterEach(
    () =>
      new Promise<void>((done) =>
        server ? server.close(() => done()) : done(),
      ),
  );

  async function listen(
    handler: Parameters<typeof createServer>[1],
  ): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it("POSTs the body with the headers, through the pinned address", async () => {
    let received:
      { headers: Record<string, unknown>; body: string } | undefined;
    const base = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received = { headers: req.headers, body };
        res.statusCode = 204;
        res.end();
      });
    });
    const port = new URL(base).port;
    const result = await nodeTransport({
      // The hostname doesn't resolve: the pinned address is what gets used.
      url: new URL(`http://hooks.example.invalid:${port}/hook`),
      address: "127.0.0.1",
      headers: buildWebhookHeaders('{"event":"x"}', { event: "x" }),
      body: '{"event":"x"}',
    });

    expect(result).toEqual({ status: 204 });
    expect(received?.body).toBe('{"event":"x"}');
    expect(received?.headers["x-shopcare-event"]).toBe("x");
    expect(received?.headers.host).toBe(`hooks.example.invalid:${port}`);
  });

  it("does not follow redirects", async () => {
    let hits = 0;
    const base = await listen((req, res) => {
      hits += 1;
      res.writeHead(302, {
        Location: "http://169.254.169.254/latest/meta-data",
      });
      res.end();
    });
    const result = await nodeTransport({
      url: new URL(`${base}/hook`),
      address: null,
      headers: {},
      body: "{}",
    });
    expect(result).toEqual({ status: 302 });
    expect(hits).toBe(1);
  });
});
