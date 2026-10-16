/**
 * First-run setup and repair services: Rails setup_test.rb and
 * admin_repair_services_test.rb. The Shopify catalogue is a FakeGraphql.
 */
import { describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import { needsSetup, partsEnabled, settingsOf } from "../../../app/models/shop.server";
import { loader as appLoader } from "../../../app/routes/app";
import { loader as homeLoader } from "../../../app/routes/app._index";
import { action as setupAction } from "../../../app/routes/app.setup";
import { loader as ticketsLoader } from "../../../app/routes/app.tickets._index";
import { action as servicesAction, loader as servicesLoader } from "../../../app/routes/app.repair_services._index";
import { action as serviceAction, loader as serviceLoader } from "../../../app/routes/app.repair_services.$id";
import { flash, get, post, signedOut, signInAs, statusOf } from "../../support/admin";
import { buildWorkshop, createProductGroupFor, createRepairServiceFor, createShop } from "../../support/factories";
import { FakeGraphql } from "../../support/fake-graphql";

type Home = Awaited<ReturnType<typeof ticketsLoader>>;

const collectionProducts = (products: { id: string; title: string; variants: { id: string; title: string; price: string }[] }[]) => ({
  "collection(": {
    collection: {
      products: {
        nodes: products.map((p) => ({
          id: `gid://shopify/Product/${p.id}`,
          title: p.title,
          variants: { nodes: p.variants.map((v) => ({ ...v, id: `gid://shopify/ProductVariant/${v.id}` })) },
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  },
});

describe("setup", () => {
  it("a new shop sees the three steps on the home page until it finishes", async () => {
    const shop = await createShop({ shopifyDomain: "setup-admin.myshopify.com" });
    signInAs(shop);
    for (const step of [1, 2, 3]) {
      const home = await get<Home>(ticketsLoader, `/app/tickets?setup_step=${step}`);
      expect(home.wizard?.step).toBe(step);
    }
    expect((await get<Home>(ticketsLoader, "/app/tickets?setup_step=9")).wizard?.step).toBe(3);

    const res = await post(setupAction, "/app/setup", { intent: "complete" });
    expect(flash(res)).toEqual({ path: "/app/tickets", notice: "You're all set." });
    expect(needsSetup(await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } }))).toBe(false);
    expect((await get<Home>(ticketsLoader, "/app/tickets")).wizard).toBeNull();
  });

  it("the admin home is the tickets list, keeping the setup step", async () => {
    signInAs(await createShop());
    const res = await get(homeLoader, "/app?setup_step=2");
    expect(flash(res).path).toBe("/app/tickets?setup_step=2");
  });

  it("skip setup", async () => {
    const shop = await createShop();
    signInAs(shop);
    const res = await post(setupAction, "/app/setup", { intent: "complete", skipped: "1" });
    expect(flash(res).notice).toMatch(/skipped/);
    expect(needsSetup(await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } }))).toBe(false);
  });

  it("step 2 imports repair services from the chosen collection", async () => {
    const shop = await createShop();
    const admin = new FakeGraphql(
      collectionProducts([
        { id: "1", title: "Resole", variants: [{ id: "900", title: "Default Title", price: "60.00" }] },
        { id: "2", title: "Heel", variants: [{ id: "901", title: "Rubber", price: "20.00" }] },
      ]),
    );
    signInAs(shop, { admin });

    const res = await post(setupAction, "/app/setup", {
      intent: "services",
      collection_id: "gid://shopify/Collection/55",
      collection_title: "Repairs",
    });

    expect(flash(res)).toEqual({ path: "/app/tickets?setup_step=2", notice: "Imported 2 repair services." });
    expect(settingsOf(await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).repair_products).toMatchObject({
      mode: "collection",
      collection_id: "55",
      collection_title: "Repairs",
    });
    expect(admin.calls[0].variables).toMatchObject({ id: "gid://shopify/Collection/55" });
  });

  it("step 2 without a collection uses the 'repair' tag; Shopify errors are shown", async () => {
    const shop = await createShop();
    signInAs(shop, { admin: new FakeGraphql({}) });
    const res = await post(setupAction, "/app/setup", { intent: "services" });
    expect(flash(res).alert).toMatch(/^We couldn't read your products from Shopify/);
    expect(settingsOf(await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).repair_products).toMatchObject({
      mode: "tag",
      tag: "repair",
    });
  });

  it("step 3 creates a default warranty for a product group", async () => {
    const shop = await createShop();
    signInAs(shop);
    const group = await createProductGroupFor(shop, { name: "Boots", rule: "product_type", productType: "Boots" });

    const res = await post(setupAction, "/app/setup", { intent: "warranty", months: "12", product_group_id: String(group.id) });

    expect(flash(res)).toEqual({ path: "/app/tickets?setup_step=3", notice: "12-month warranty switched on." });
    const policy = await prisma.warrantyPolicy.findFirstOrThrow();
    expect([policy.name, policy.months, policy.outcome, policy.productGroupId]).toEqual([
      "12-month warranty", 12, "free", group.id,
    ]);
    expect((await get<Home>(ticketsLoader, "/app/tickets?setup_step=3")).wizard?.policyNames).toBe("12-month warranty");
  });

  it("workshop inventory is off for a new shop, and finishing setup can switch it on", async () => {
    const shop = await createShop();
    signInAs(shop);
    expect((await get<Home>(ticketsLoader, "/app/tickets?setup_step=3")).wizard?.partsEnabled).toBe(false);
    expect((await get<{ partsEnabled: boolean }>(appLoader, "/app")).partsEnabled).toBe(false);

    await post(setupAction, "/app/setup", { intent: "complete", parts_enabled: ["0", "1"] });
    expect(partsEnabled(await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } }))).toBe(true);
    expect((await get<{ partsEnabled: boolean }>(appLoader, "/app")).partsEnabled).toBe(true);
  });

  it("another shop's product group can't be used for the warranty", async () => {
    signInAs(await createShop());
    const foreign = await createProductGroupFor(await createShop());
    const res = await post(setupAction, "/app/setup", { intent: "warranty", product_group_id: String(foreign.id) });
    expect(statusOf(res)).toBe(404);
  });
});

describe("repair services", () => {
  it("have their own page, whether or not parts are tracked", async () => {
    const shop = await createShop({ settings: { currency: "GBP" } });
    signInAs(shop);
    await createRepairServiceFor(shop, { title: "Full resole", shopifyVariantId: "900", price: 60 });
    const data = await get<Awaited<ReturnType<typeof servicesLoader>>>(servicesLoader, "/app/repair_services");
    expect(data.services.map((s) => [s.title, s.price])).toEqual([["Full resole", "£60.00"]]);
    expect([data.partsEnabled, data.catalogConfigured]).toEqual([false, true]);
  });

  it("import from a chosen collection remembers it and syncs", async () => {
    const shop = await createShop();
    signInAs(shop, {
      admin: new FakeGraphql(
        collectionProducts([{ id: "1", title: "Resole", variants: [{ id: "900", title: "Default Title", price: "65.00" }] }]),
      ),
    });
    const res = await post(servicesAction, "/app/repair_services", {
      collection_id: "gid://shopify/Collection/55",
      collection_title: "Repairs",
    });
    expect(flash(res)).toEqual({ path: "/app/repair_services", notice: "Synced: 1 added, 0 updated, 0 switched off." });
    expect(settingsOf(await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).repair_products).toEqual({
      mode: "collection",
      collection_id: "55",
      collection_title: "Repairs",
    });
  });

  it("a service can be edited; recipes need workshop inventory", async () => {
    const shop = await createShop({ settings: { parts_enabled: true } });
    signInAs(shop);
    const { service, glue } = await buildWorkshop(shop);
    const params = { id: String(service.id) };

    const res = await post(serviceAction, `/app/repair_services/${service.id}`, {
      intent: "update",
      labour_minutes: "30",
      active: ["0"],
    }, params);
    expect(flash(res)).toEqual({ path: `/app/repair_services/${service.id}`, notice: "Service saved." });
    const saved = await prisma.repairService.findUniqueOrThrow({ where: { id: service.id } });
    expect([saved.labourMinutes, saved.active]).toEqual([30, false]);

    const data = await get<Awaited<ReturnType<typeof serviceLoader>>>(serviceLoader, `/app/repair_services/${service.id}`, params);
    expect(data.components.map((c) => c.partName)).toEqual(["Commando sole", "Adhesive"]);

    await prisma.shop.update({ where: { id: shop.id }, data: { settings: { parts_enabled: false } } });
    const blocked = await post(serviceAction, `/app/repair_services/${service.id}`, {
      intent: "add_component",
      part_id: String(glue.id),
      quantity: "1",
    }, params);
    expect(flash(blocked).path).toBe("/app/tickets");
    expect(await prisma.serviceComponent.count({ where: { repairServiceId: service.id } })).toBe(2);
    expect((await get<Awaited<ReturnType<typeof serviceLoader>>>(serviceLoader, `/app/repair_services/${service.id}`, params)).components).toEqual([]);
  });

  it("build a recipe line with a fixed colour, and remove it", async () => {
    const shop = await createShop({ settings: { parts_enabled: true } });
    signInAs(shop);
    const { service } = await buildWorkshop(shop);
    const laces = await prisma.part.create({ data: { shopId: shop.id, name: "Laces", optionNames: ["colour"] } });
    const params = { id: String(service.id) };

    const res = await post(serviceAction, `/app/repair_services/${service.id}`, {
      intent: "add_component",
      part_id: String(laces.id),
      quantity: "1",
      "match[colour]": "fixed",
      "fixed[colour]": "Black",
    }, params);
    expect(flash(res).notice).toBe("Laces added to the recipe.");
    const component = await prisma.serviceComponent.findFirstOrThrow({ where: { partId: laces.id } });
    expect(component.match).toEqual({ colour: "fixed:Black" });

    const removed = await post(serviceAction, `/app/repair_services/${service.id}`, {
      intent: "remove_component",
      component_id: String(component.id),
    }, params);
    expect(flash(removed).notice).toBe("Part removed from the recipe.");
  });

  it("another shop's service and parts can't be used", async () => {
    const shop = await createShop({ settings: { parts_enabled: true } });
    signInAs(shop);
    const mine = await createRepairServiceFor(shop);
    const other = await createShop({ settings: { parts_enabled: true } });
    const { service: theirs, glue: theirGlue } = await buildWorkshop(other);
    expect(statusOf(await get(serviceLoader, `/app/repair_services/${theirs.id}`, { id: String(theirs.id) }))).toBe(404);
    const res = await post(serviceAction, `/app/repair_services/${mine.id}`, {
      intent: "add_component",
      part_id: String(theirGlue.id),
    }, { id: String(mine.id) });
    expect(statusOf(res)).toBe(404);
    expect(await prisma.serviceComponent.count({ where: { repairServiceId: mine.id } })).toBe(0);
  });
});

describe("authentication", () => {
  it("a request without an admin session is sent to log in, not served", async () => {
    signedOut();
    const res = await get(servicesLoader, "/app/repair_services");
    expect(statusOf(res)).toBe(302);
  });
});
