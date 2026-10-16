import { describe, expect, it } from "vitest";
import { publicCacheHeaders } from "../../app/lib/http.server";

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
});
