import { describe, expect, it } from "vitest";
import {
  jsonResponse,
  liquidResponse,
  liquidText,
  privateNoStoreHeaders,
  publicCacheHeaders,
} from "../../app/lib/http.server";

describe("publicCacheHeaders", () => {
  it("caches durably on Netlify's CDN, keyed only on shop and the listed params", () => {
    const headers = publicCacheHeaders({
      maxAge: 300,
      varyOn: ["product_id"],
      tags: ["shop:a"],
    });
    expect(headers.get("Netlify-CDN-Cache-Control")).toBe(
      "public, durable, max-age=300, stale-while-revalidate=1200",
    );
    expect(headers.get("Netlify-Vary")).toBe("query=shop|product_id");
    expect(headers.get("Netlify-Cache-Tag")).toBe("shop:a");
    expect(headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("never lists shop twice and omits tags when there are none", () => {
    const headers = publicCacheHeaders({ maxAge: 60, varyOn: ["shop", "q"] });
    expect(headers.get("Netlify-Vary")).toBe("query=shop|q");
    expect(headers.has("Netlify-Cache-Tag")).toBe(false);
  });
});

describe("privateNoStoreHeaders", () => {
  it("keeps the response out of the browser and the CDN", () => {
    const headers = privateNoStoreHeaders();
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    expect(headers.get("Netlify-CDN-Cache-Control")).toBe("no-store");
    expect(headers.has("Netlify-Vary")).toBe(false);
  });
});

describe("jsonResponse", () => {
  it("is no-store for customer data", async () => {
    const response = jsonResponse(
      { ok: true },
      { cache: "no-store", status: 201 },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("carries the public CDN headers when asked", () => {
    const response = jsonResponse(
      { results: [] },
      { cache: { maxAge: 120, varyOn: ["q"] }, headers: { "X-Extra": "1" } },
    );
    expect(response.headers.get("Netlify-CDN-Cache-Control")).toBe(
      "public, durable, max-age=120, stale-while-revalidate=480",
    );
    expect(response.headers.get("Netlify-Vary")).toBe("query=shop|q");
    expect(response.headers.get("X-Extra")).toBe("1");
  });
});

describe("liquidText", () => {
  it("escapes HTML and Liquid braces, like Rails liquid_text", () => {
    expect(liquidText(`{{ shop.name }} {% if x %}<b>"A&B's"</b>`)).toBe(
      "&#123;&#123; shop.name &#125;&#125; &#123;% if x %&#125;&lt;b&gt;&quot;A&amp;B&#39;s&quot;&lt;/b&gt;",
    );
    expect(liquidText(null)).toBe("");
    expect(liquidText(42)).toBe("42");
  });
});

describe("liquidResponse", () => {
  it("is application/liquid and no-store, inside the theme layout by default", async () => {
    const response = liquidResponse("<p>Hi</p>", { status: 404 });
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("application/liquid");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).toBe("<p>Hi</p>");
  });

  it("can render without the theme layout", async () => {
    const response = liquidResponse("<p>Hi</p>", { layout: false });
    expect(await response.text()).toBe("{% layout none %}<p>Hi</p>");
  });
});
