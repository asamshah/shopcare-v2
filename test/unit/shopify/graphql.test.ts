import { describe, expect, it, vi } from "vitest";
import { buildGid, numericId } from "../../../app/lib/gid";
import {
  adminGraphql,
  assertNoUserErrors,
  moneyString,
  ShopifyGraphqlError,
  STOREFRONT_RETRY,
  withRetry,
  ShopifyUserError,
  type AdminGraphqlClient,
} from "../../../app/shopify/graphql.server";
import { FakeGraphql } from "../../support/fake-graphql";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** A client that plays back one result (a Response or a thrown error) per call. */
function scripted(...results: (Response | Error)[]): AdminGraphqlClient & {
  graphql: ReturnType<typeof vi.fn>;
} {
  const graphql = vi.fn(async () => {
    const next = results.shift();
    if (!next) throw new Error("no more scripted results");
    if (next instanceof Error) throw next;
    return next;
  });
  return { graphql };
}

const throttledBody = {
  errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
  extensions: {
    cost: {
      requestedQueryCost: 102,
      throttleStatus: {
        currentlyAvailable: 2,
        restoreRate: 100,
        maximumAvailable: 2000,
      },
    },
  },
};

/** Shaped like @shopify/shopify-api's GraphqlQueryError for a THROTTLED reply. */
function libraryThrottledError() {
  return Object.assign(new Error("Throttled"), {
    name: "GraphqlQueryError",
    body: {
      errors: { graphQLErrors: throttledBody.errors },
      extensions: throttledBody.extensions,
    },
  });
}

describe("gid", () => {
  it("converts between GIDs and numeric ids", () => {
    expect(numericId("gid://shopify/Product/123")).toBe("123");
    expect(numericId("gid://shopify/LineItem/9?x=1")).toBe("9");
    expect(numericId("42")).toBe("42");
    expect(buildGid("Product", 123)).toBe("gid://shopify/Product/123");
    expect(buildGid("Product", "gid://shopify/Product/1")).toBe(
      "gid://shopify/Product/1",
    );
  });
});

describe("adminGraphql", () => {
  it("returns data and passes the variables through", async () => {
    const api = new FakeGraphql({ "shop {": { shop: { name: "Acme" } } });
    const data = await adminGraphql<{ shop: { name: string } }>(
      api,
      "query { shop { name } }",
      { a: 1 },
    );
    expect(data.shop.name).toBe("Acme");
    expect(api.calls[0].variables).toEqual({ a: 1 });
  });

  it("raises GraphQL errors from the response body", async () => {
    const client = scripted(json({ errors: [{ message: "Access denied" }] }));
    await expect(adminGraphql(client, "query { x }")).rejects.toMatchObject({
      name: "ShopifyGraphqlError",
      message: "Access denied",
    });
  });

  it("raises GraphQL errors the library client throws", async () => {
    const error = Object.assign(new Error("Field 'x' doesn't exist"), {
      body: {
        errors: { graphQLErrors: [{ message: "Field 'x' doesn't exist" }] },
      },
    });
    await expect(
      adminGraphql(scripted(error), "query { x }"),
    ).rejects.toBeInstanceOf(ShopifyGraphqlError);
  });

  it("passes network errors on unchanged", async () => {
    const error = new TypeError("fetch failed");
    await expect(adminGraphql(scripted(error), "query { x }")).rejects.toBe(
      error,
    );
  });

  it("retries THROTTLED with a wait long enough for the bucket to refill", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const client = scripted(json(throttledBody), json({ data: { ok: true } }));

    const data = await adminGraphql(client, "query { ok }", {}, { sleep });

    expect(data).toEqual({ ok: true });
    expect(client.graphql).toHaveBeenCalledTimes(2);
    // (102 - 2) / 100 per second = 1s, and at least the 1s base backoff.
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("retries a THROTTLED error thrown by the library, then HTTP 429, with growing backoff", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const throttling = Object.assign(
      new Error("Shopify is throttling requests"),
      {
        name: "HttpThrottlingError",
        retryAfter: 0.5,
      },
    );
    const client = scripted(
      libraryThrottledError(),
      throttling,
      json({}, 429),
      json({ data: { ok: true } }),
    );

    await adminGraphql(client, "query { ok }", {}, { sleep, baseDelayMs: 100 });

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 500, 400]);
  });

  it("gives up after maxAttempts with the throttling error", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const client = scripted(
      json(throttledBody),
      json(throttledBody),
      json(throttledBody),
    );

    const failure = adminGraphql(
      client,
      "query { ok }",
      {},
      { sleep, maxAttempts: 3 },
    );

    await expect(failure).rejects.toMatchObject({ throttled: true });
    expect(client.graphql).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("a storefront client retries once, after the wait Shopify asks for (at most 2 s)", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const inner = scripted(json(throttledBody), json(throttledBody), json({ data: { ok: true } }));
    const client = withRetry(inner, { ...STOREFRONT_RETRY, sleep });

    await expect(adminGraphql(client, "query { ok }")).rejects.toMatchObject({ throttled: true });
    expect(inner.graphql).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1000); // 100 points short at 100 a second
  });

  it("a storefront client never waits more than 2 s", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const slow = { ...throttledBody, extensions: { cost: { requestedQueryCost: 900, throttleStatus: { currentlyAvailable: 0, restoreRate: 50 } } } };
    const client = withRetry(scripted(json(slow), json({ data: { ok: true } })), { ...STOREFRONT_RETRY, sleep });
    expect(await adminGraphql(client, "query { ok }")).toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2000); // Shopify asked for 18 s
  });

  it("a call's own retry options win over the client's", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const inner = scripted(json(throttledBody), json(throttledBody), json({ data: { ok: true } }));
    const client = withRetry(inner, { ...STOREFRONT_RETRY, sleep });
    expect(await adminGraphql(client, "query { ok }", {}, { maxAttempts: 3 })).toEqual({ ok: true });
  });
});

describe("assertNoUserErrors", () => {
  it("raises the user errors' messages", () => {
    expect(() =>
      assertNoUserErrors("draftOrderCreate", {
        userErrors: [
          { field: ["input"], message: "Email is invalid" },
          { field: null, message: "Add a line" },
        ],
      }),
    ).toThrow(ShopifyUserError);
    expect(() =>
      assertNoUserErrors("x", {
        userErrors: [{ message: "a" }, { message: "b" }],
      }),
    ).toThrow("a, b");
    expect(() => assertNoUserErrors("x", { userErrors: [] })).not.toThrow();
  });
});

describe("moneyString", () => {
  it("formats amounts to two places", () => {
    expect(moneyString(12.5)).toBe("12.50");
    expect(moneyString("30")).toBe("30.00");
    expect(() => moneyString("abc")).toThrow();
  });
});
