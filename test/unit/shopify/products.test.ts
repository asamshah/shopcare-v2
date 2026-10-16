/**
 * Ported from Rails test/services/repairs/product_catalog_test.rb, the
 * catalogue half of repairs/order_lookup_and_catalog_test.rb and
 * parts/item_properties_test.rb, plus Warranty::ProductFacts (which Rails
 * tested through the cover-assigner tests).
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../../../app/shopify/cache.server";
import {
  catalogSearchQuery,
  cleanCatalogTerm,
  searchCatalog,
} from "../../../app/shopify/catalog-search.server";
import {
  fetchVariantProperties,
  ProductFacts,
} from "../../../app/shopify/product-facts.server";
import {
  fetchRepairVariant,
  fetchRepairVariants,
  listRepairVariants,
  repairProductsConfigured,
} from "../../../app/shopify/repair-products.server";
import { FakeGraphql } from "../../support/fake-graphql";

const quiet = { error: vi.fn() };

describe("repair products", () => {
  const productNode = {
    id: "gid://shopify/Product/10",
    title: "Sole replacement",
    variants: {
      nodes: [
        {
          id: "gid://shopify/ProductVariant/100",
          title: "Default Title",
          price: "18.00",
        },
      ],
    },
  };
  const page = (nodes = [productNode]) => ({
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  });

  it("uses the “repair” tag until the merchant sets one; a collection source needs a collection", async () => {
    const api = new FakeGraphql({ "products(first:": { products: page() } });
    expect(await fetchRepairVariants(api, {})).toHaveLength(1);
    expect(api.calls.at(-1)?.variables.q).toBe("tag:'repair'");

    const settings = { mode: "collection" };
    expect(repairProductsConfigured(settings)).toBe(false);
    expect(
      await listRepairVariants(new FakeGraphql(), settings, { shopKey: "s" }),
    ).toEqual([]);
  });

  it("lists variants by tag with numeric ids", async () => {
    const api = new FakeGraphql({ "products(first:": { products: page() } });

    const variants = await fetchRepairVariants(api, {
      mode: "tag",
      tag: "it's repair",
    });

    expect(variants).toEqual([
      {
        productId: "10",
        productTitle: "Sole replacement",
        variantId: "100",
        variantTitle: "Default Title",
        price: "18.00",
        label: "Sole replacement", // "Default Title" hidden
      },
    ]);
    expect(api.calls[0].variables.q).toBe("tag:'it\\'s repair'");
  });

  it("lists variants by collection using the collection query, following pages", async () => {
    const pages = [
      {
        collection: {
          products: {
            ...page(),
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
        },
      },
      { collection: { products: page() } },
    ];
    const api = new FakeGraphql({ "collection(id:": () => pages.shift() });

    const variants = await fetchRepairVariants(api, {
      mode: "collection",
      collectionId: "555",
    });

    expect(variants.map((v) => v.variantId)).toEqual(["100", "100"]);
    expect(api.calls[0].variables).toMatchObject({
      id: "gid://shopify/Collection/555",
      after: null,
    });
    expect(api.calls[1].variables.after).toBe("c1");
  });

  it("fetchRepairVariant resolves a single variant authoritatively", async () => {
    const api = new FakeGraphql({
      "productVariant(id:": {
        productVariant: {
          id: "gid://shopify/ProductVariant/100",
          title: "Leather",
          price: "20.00",
          product: {
            id: "gid://shopify/Product/10",
            title: "Sole replacement",
          },
        },
      },
    });

    const variant = await fetchRepairVariant(api, "100");

    expect(variant).toMatchObject({
      variantId: "100",
      productId: "10",
      label: "Sole replacement — Leather",
    });
    expect(api.calls[0].variables.id).toBe("gid://shopify/ProductVariant/100");
  });

  it("the picker list is empty when the API raises, and the failure isn't cached", async () => {
    const cache = new MemoryCache();
    const failing = new FakeGraphql({
      "products(first:": () => {
        throw new Error("boom");
      },
    });
    const options = { shopKey: "s", cache, logger: quiet };
    expect(
      await listRepairVariants(failing, { tag: "repair" }, options),
    ).toEqual([]);

    const api = new FakeGraphql({ "products(first:": { products: page() } });
    expect(
      await listRepairVariants(api, { tag: "repair" }, options),
    ).toHaveLength(1);
    expect(
      await listRepairVariants(api, { tag: "repair" }, options),
    ).toHaveLength(1);
    expect(api.calls).toHaveLength(1); // the second came from the cache
  });
});

describe("catalogue search", () => {
  const productNode = (
    id: number,
    title: string,
    variants: [number, string, string | null][],
  ) => ({
    id: `gid://shopify/Product/${id}`,
    title,
    featuredMedia: { preview: { image: { url: `https://cdn/${id}.jpg` } } },
    variants: {
      nodes: variants.map(([vid, vtitle, sku]) => ({
        id: `gid://shopify/ProductVariant/${vid}`,
        title: vtitle,
        sku,
        media: { nodes: [] },
      })),
    },
  });

  it("public facts only, a SKU names its variant, repair services and Care are left out", async () => {
    const api = new FakeGraphql({
      "products(first:": {
        products: {
          nodes: [
            productNode(10, "Aria Boot", [
              [100, "UK 7", "ARIA-7"],
              [101, "UK 8", "ARIA-8"],
            ]),
            productNode(11, "Aria Sandal", [[110, "Default Title", "SAN-1"]]),
            productNode(90, "Full resole", [[900, "Default Title", null]]),
          ],
        },
      },
    });

    const results = await searchCatalog(api, "aria-8", {
      shopKey: "lookup-test",
      excludedVariantIds: ["900"],
      cache: new MemoryCache(),
    });

    expect(results.map((r) => r.productTitle)).toEqual([
      "Aria Boot",
      "Aria Sandal",
    ]);
    expect(results[0]).toEqual({
      productId: "10",
      productTitle: "Aria Boot",
      imageUrl: "https://cdn/10.jpg",
      variantId: "101",
      variantTitle: "UK 8",
      sku: "ARIA-8",
      variants: null,
    });
    // One variant: named, no "Default Title".
    expect([results[1].variantId, results[1].variantTitle]).toEqual([
      "110",
      null,
    ]);
    const q = api.calls[0].variables.q as string;
    expect(q).toContain(
      "status:active AND published_status:published AND gift_card:false",
    );
    expect(q).toContain("OR sku:aria-8");
  });

  it("a name lists the variants to choose from; short or syntax-only terms don't search", async () => {
    const api = new FakeGraphql({
      "products(first:": {
        products: {
          nodes: [
            productNode(10, "Aria Boot", [
              [100, "UK 7", "ARIA-7"],
              [101, "UK 8", "ARIA-8"],
            ]),
          ],
        },
      },
    });
    const options = { shopKey: "s", cache: new MemoryCache() };

    const [result] = await searchCatalog(api, "aria boot", options);

    expect(result.variantId).toBeNull();
    expect(result.variants?.map((v) => v.variantTitle)).toEqual([
      "UK 7",
      "UK 8",
    ]);
    expect(api.calls.at(-1)?.variables.q).toBe(
      "status:active AND published_status:published AND gift_card:false AND (title:aria* AND title:boot*)",
    );

    expect(await searchCatalog(api, "a", options)).toEqual([]);
    expect(await searchCatalog(api, `" : ( )`, options)).toEqual([]);
    expect(api.calls).toHaveLength(1);
  });

  it("cleans search syntax out of terms", () => {
    expect(cleanCatalogTerm(`  title:"boot" (x) `)).toBe("title boot x");
    expect(catalogSearchQuery("-boot")).toContain(
      "((title:boot*) OR sku:-boot)",
    );
  });

  it("a failure gives no results", async () => {
    const api = new FakeGraphql({
      "products(first:": () => {
        throw new Error("boom");
      },
    });
    expect(
      await searchCatalog(api, "boot", {
        shopKey: "s",
        cache: new MemoryCache(),
        logger: quiet,
      }),
    ).toEqual([]);
  });
});

describe("product facts", () => {
  const product = {
    id: "gid://shopify/Product/10",
    title: "Aria Boot",
    productType: "Boots",
    tags: ["leather", "warranty-2y"],
    collections: { nodes: [{ id: "gid://shopify/Collection/5" }] },
  };

  it("reads tags, type and collections once per instance and caches them", async () => {
    const cache = new MemoryCache();
    const api = new FakeGraphql({ "product(id:": { product } });
    const facts = new ProductFacts(api, { shopKey: "s", cache });

    const first = await facts.fetch("10");
    await facts.fetch("10");
    await new ProductFacts(api, { shopKey: "s", cache }).fetch("10");

    expect(first).toEqual({
      productId: "10",
      title: "Aria Boot",
      productType: "Boots",
      tags: ["leather", "warranty-2y"],
      collectionIds: ["5"],
    });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].variables.id).toBe("gid://shopify/Product/10");
  });

  it("variant facts add the variant's title and SKU", async () => {
    const api = new FakeGraphql({
      "productVariant(id:": {
        productVariant: {
          id: "gid://shopify/ProductVariant/100",
          title: "UK 7",
          sku: "AR-7",
          product,
        },
      },
    });

    const facts = await new ProductFacts(api, {
      shopKey: "s",
      cache: new MemoryCache(),
    }).fetchVariant("100");

    expect(facts).toMatchObject({
      productId: "10",
      variantId: "100",
      variantTitle: "UK 7",
      sku: "AR-7",
    });
  });

  it("an unknown product, a blank id or a failure gives null, and failures aren't cached", async () => {
    const cache = new MemoryCache();
    let fail = true;
    const api = new FakeGraphql({
      "product(id:": () => {
        if (fail) throw new Error("boom");
        return { product: null };
      },
    });
    const options = { shopKey: "s", cache, logger: quiet };

    expect(await new ProductFacts(api, options).fetch("10")).toBeNull();
    fail = false;
    expect(await new ProductFacts(api, options).fetch("10")).toBeNull();
    expect(await new ProductFacts(api, options).fetch("")).toBeNull();
    expect(api.calls).toHaveLength(2);
    expect(quiet.error).toHaveBeenCalled();
  });
});

describe("variant properties", () => {
  const response = {
    "productVariant(id:": {
      productVariant: {
        selectedOptions: [
          { name: "Size", value: "UK 8" },
          { name: "Colour", value: "Black" },
        ],
        product: { metafield: { value: "Commando" } },
      },
    },
  };

  it("reads size, colour and model from Shopify", async () => {
    const api = new FakeGraphql(response);

    const properties = await fetchVariantProperties(api, "100", {
      modelMetafield: "footwear.sole",
      sizeOption: "Size",
      colourOption: "Color, Colour",
    });

    expect(properties).toEqual({
      size: "UK 8",
      colour: "Black",
      sole_model: "Commando",
    });
    expect(api.calls[0].variables).toEqual({
      id: "gid://shopify/ProductVariant/100",
      namespace: "footwear",
      key: "sole",
      withMetafield: true,
    });
  });

  it("skips the metafield when none is configured", async () => {
    const api = new FakeGraphql(response);
    await fetchVariantProperties(api, "100", { sizeOption: "Size" });
    expect(api.calls[0].variables.withMetafield).toBe(false);
  });

  it("is null for an unknown variant", async () => {
    const api = new FakeGraphql({
      "productVariant(id:": { productVariant: null },
    });
    expect(await fetchVariantProperties(api, "100", {})).toBeNull();
  });
});
