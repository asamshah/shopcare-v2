/**
 * Items, registrations, warranty policies, product groups and Care plans:
 * Rails admin_items_test.rb (items half), product_groups_test.rb and
 * care_plans_test.rb (admin half), plus tenant isolation.
 */
import { describe, expect, it, vi } from "vitest";
import prisma from "../../../app/db.server";
import { careCoverFor, createCover } from "../../../app/models/cover.server";
import { itemsDeps } from "../../../app/services/admin/items.server";
import { action as itemAction, loader as itemLoader } from "../../../app/routes/app.items.$id";
import { action as itemsAction, loader as itemsLoader } from "../../../app/routes/app.items._index";
import { loader as policiesLoader } from "../../../app/routes/app.warranty_policies._index";
import { action as newPolicyAction, loader as newPolicyLoader } from "../../../app/routes/app.warranty_policies.new";
import { action as policyAction, loader as policyLoader } from "../../../app/routes/app.warranty_policies.$id";
import { loader as groupsLoader } from "../../../app/routes/app.product_groups._index";
import { action as newGroupAction } from "../../../app/routes/app.product_groups.new";
import { action as groupAction, loader as groupLoader } from "../../../app/routes/app.product_groups.$id";
import { loader as plansLoader } from "../../../app/routes/app.care_plans._index";
import { action as newPlanAction, loader as newPlanLoader } from "../../../app/routes/app.care_plans.new";
import { loader as planLoader } from "../../../app/routes/app.care_plans.$id._index";
import { action as editPlanAction, loader as editPlanLoader } from "../../../app/routes/app.care_plans.$id.edit";
import { dataOf, flash, get, post, signInAs, statusOf } from "../../support/admin";
import {
  buildCare,
  createCarePlanFor,
  createItemFor,
  createProductGroupFor,
  createRegistrationFor,
  createShop,
  createWarrantyCover,
  createWarrantyPolicyFor,
  daysAgo,
} from "../../support/factories";
import { FakeGraphql } from "../../support/fake-graphql";

async function shopFor(domain: string, settings: Record<string, string> = { currency: "GBP" }) {
  const shop = await createShop({ shopifyDomain: domain, settings });
  signInAs(shop);
  return shop;
}

describe("items", () => {
  it("index, filters, search and show render; registrations can be verified or rejected", async () => {
    const shop = await shopFor("admin-items.myshopify.com");
    const policy = await createWarrantyPolicyFor(shop);
    const item = await createItemFor(shop, {
      shopifyCustomerId: "777",
      customerEmail: "c@example.com",
      productTitle: "Aria Boot",
      orderName: "#1042",
      purchasedAt: daysAgo(30),
    });
    await createWarrantyCover(shop, { item, policy });
    const registered = await createItemFor(shop, { productTitle: "Trail Runner", source: "registration" });
    const registration = await createRegistrationFor(shop, registered.id);

    type Items = Awaited<ReturnType<typeof itemsLoader>>;
    expect((await get<Items>(itemsLoader, "/app/items?filter=covered")).items.map((i) => i.id)).toEqual([item.id]);
    expect((await get<Items>(itemsLoader, "/app/items?filter=registrations")).items.map((i) => i.id)).toEqual([registered.id]);
    expect((await get<Items>(itemsLoader, "/app/items?filter=unverified")).items.map((i) => i.id)).toEqual([registered.id]);
    const search = await get<Items>(itemsLoader, "/app/items?q=aria");
    expect(search.items).toHaveLength(1);
    expect(search.unverifiedCount).toBe(1);

    type Item = Awaited<ReturnType<typeof itemLoader>>;
    const shown = await get<Item>(itemLoader, `/app/items/${registered.id}`, { id: String(registered.id) });
    expect(shown.registration?.unverified).toBe(true);
    const covered = await get<Item>(itemLoader, `/app/items/${item.id}`, { id: String(item.id) });
    expect(covered.covers.map((c) => [c.name, c.state])).toEqual([["12-month warranty", "Active"]]);
    expect(covered.covers[0].credit).toBeNull();

    // A Care credit code (ShopCare doesn't email it): staff see it to share.
    const cover = await prisma.cover.findFirstOrThrow({ where: { itemId: item.id } });
    await prisma.careCredit.create({
      data: { shopId: shop.id, coverId: cover.id, code: "CARE-7XK2", amount: 15, expiresAt: new Date(Date.UTC(2027, 0, 14)) },
    });
    const credited = await get<Item>(itemLoader, `/app/items/${item.id}`, { id: String(item.id) });
    expect(credited.covers[0].credit?.code).toBe("CARE-7XK2");
    expect(credited.covers[0].credit?.text).toMatch(/^Care credit code CARE-7XK2 for £15\.00, use by .+2027\. Give it to the customer/);

    const res = await post(itemAction, `/app/items/${registered.id}`, { intent: "verify", note: "Receipt checked" }, {
      id: String(registered.id),
    });
    expect(flash(res)).toEqual({ path: `/app/items/${registered.id}`, notice: "Registration verified." });
    const verified = await prisma.registration.findUniqueOrThrow({ where: { id: registration.id } });
    expect([verified.status, verified.reviewNote]).toEqual(["verified", "Receipt checked"]);
  });

  it("rejecting a registration voids the item and cancels its cover", async () => {
    const shop = await shopFor("admin-items.myshopify.com");
    const item = await createItemFor(shop, { source: "registration" });
    await createRegistrationFor(shop, item.id);
    const cover = await createWarrantyCover(shop, { item });
    const res = await post(itemAction, `/app/items/${item.id}`, { intent: "reject" }, { id: String(item.id) });
    expect(flash(res).notice).toBe("Registration rejected and cover cancelled.");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("void");
    expect((await prisma.cover.findUniqueOrThrow({ where: { id: cover.id } })).status).toBe("cancelled");
  });

  it("import queues the order backfill", async () => {
    const shop = await shopFor("admin-items.myshopify.com");
    const enqueue = vi.spyOn(itemsDeps, "enqueueImport").mockResolvedValue();
    const res = await post(itemsAction, "/app/items");
    expect(flash(res).notice).toBe("Importing recent orders. Refresh in a minute to see the items.");
    expect(enqueue).toHaveBeenCalledWith(shop.id);
    const settings = (await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).settings as Record<string, { status: string }>;
    expect(settings.items_import.status).toBe("queued");
    type Items = Awaited<ReturnType<typeof itemsLoader>>;
    expect((await get<Items>(itemsLoader, "/app/items")).import?.running).toBe(true);
    enqueue.mockRestore();
  });

  it("another shop's item and registration can't be seen or reviewed", async () => {
    await shopFor("admin-items.myshopify.com");
    const other = await createShop();
    const theirs = await createItemFor(other, { source: "registration" });
    await createRegistrationFor(other, theirs.id);
    expect(statusOf(await get(itemLoader, `/app/items/${theirs.id}`, { id: String(theirs.id) }))).toBe(404);
    expect(statusOf(await post(itemAction, `/app/items/${theirs.id}`, { intent: "verify" }, { id: String(theirs.id) }))).toBe(404);
    expect((await prisma.registration.findFirstOrThrow()).status).toBe("unverified");
  });
});

describe("warranty policies", () => {
  it("can be created, edited and deleted", async () => {
    const shop = await shopFor("admin-items.myshopify.com");
    expect((await get<Awaited<ReturnType<typeof policiesLoader>>>(policiesLoader, "/app/warranty_policies")).policies).toEqual([]);
    const form = await get<Awaited<ReturnType<typeof newPolicyLoader>>>(newPolicyLoader, "/app/warranty_policies/new");
    expect(form.values.name).toBe("12-month warranty");

    const leather = await createProductGroupFor(shop, { name: "Leather", rule: "tags", tags: ["leather"] });
    const res = await post(newPolicyAction, "/app/warranty_policies/new", {
      name: "Leather",
      months: "24",
      outcome: "discount",
      discount_percent: "50",
      product_group_id: String(leather.id),
      active: ["0", "1"],
    });
    expect(flash(res)).toEqual({ path: "/app/warranty_policies", notice: "Warranty policy created." });
    const policy = await prisma.warrantyPolicy.findFirstOrThrow({ where: { name: "Leather" } });
    expect([policy.productGroupId, policy.months, policy.outcome, policy.discountPercent.toNumber()]).toEqual([
      leather.id, 24, "discount", 50,
    ]);

    const params = { id: String(policy.id) };
    await post(policyAction, `/app/warranty_policies/${policy.id}`, { name: "Leather", months: "36", active: ["0"] }, params);
    const saved = await prisma.warrantyPolicy.findUniqueOrThrow({ where: { id: policy.id } });
    expect([saved.months, saved.active, saved.outcome, saved.productGroupId]).toEqual([36, false, "discount", leather.id]);
    const edit = await get<Awaited<ReturnType<typeof policyLoader>>>(policyLoader, `/app/warranty_policies/${policy.id}`, params);
    expect(edit.preview[0]).toBe("50% off repairs for 36 months from the date you bought your item.");

    const deleted = await post(policyAction, `/app/warranty_policies/${policy.id}`, { intent: "delete" }, params);
    expect(flash(deleted).notice).toBe("Warranty policy deleted. Existing cover is unaffected.");
    expect(await prisma.warrantyPolicy.count()).toBe(0);
  });

  it("an invalid policy re-renders the form with the messages", async () => {
    await shopFor("admin-items.myshopify.com");
    const res = await post(newPolicyAction, "/app/warranty_policies/new", { name: "", months: "12", product_group_id: "" });
    expect(statusOf(res)).toBe(422);
    const body = dataOf<{ errors: string[]; values: { months: string } }>(res);
    expect(body.errors).toEqual(["Name can't be blank"]);
    expect(body.values.months).toBe("12");
  });

  it("another shop's product group can't be chosen", async () => {
    await shopFor("groups-admin.myshopify.com");
    const other = await createShop({ shopifyDomain: "groups-other.myshopify.com" });
    const foreign = await createProductGroupFor(other, { name: "Theirs" });
    const res = await post(newPolicyAction, "/app/warranty_policies/new", {
      name: "W",
      months: "12",
      product_group_id: String(foreign.id),
    });
    expect(statusOf(res)).toBe(404);
    expect(await prisma.warrantyPolicy.count()).toBe(0);
  });

  it("another shop's policy can't be seen or deleted", async () => {
    await shopFor("admin-items.myshopify.com");
    const other = await createShop();
    const theirs = await createWarrantyPolicyFor(other);
    const params = { id: String(theirs.id) };
    expect(statusOf(await get(policyLoader, `/app/warranty_policies/${theirs.id}`, params))).toBe(404);
    expect(statusOf(await post(policyAction, `/app/warranty_policies/${theirs.id}`, { intent: "delete" }, params))).toBe(404);
    expect(await prisma.warrantyPolicy.count()).toBe(1);
  });
});

describe("product groups", () => {
  it("create a group from the resource picker's collections, then edit and delete it", async () => {
    const shop = await shopFor("groups-admin.myshopify.com");
    expect((await get<Awaited<ReturnType<typeof groupsLoader>>>(groupsLoader, "/app/product_groups")).groups).toEqual([]);

    const picked = JSON.stringify([{ id: "gid://shopify/Collection/77", title: "Leather boots", handle: "leather" }]);
    const res = await post(newGroupAction, "/app/product_groups/new", { name: "Leather", rule: "collections", collections_json: picked });
    expect(flash(res)).toEqual({ path: "/app/product_groups", notice: "Product group created." });
    const group = await prisma.productGroup.findFirstOrThrow({ where: { shopId: shop.id } });
    expect(group.collections).toEqual([{ id: "gid://shopify/Collection/77", title: "Leather boots" }]);

    const params = { id: String(group.id) };
    expect((await get<Awaited<ReturnType<typeof groupLoader>>>(groupLoader, `/app/product_groups/${group.id}`, params)).values.collections).toHaveLength(1);
    await post(groupAction, `/app/product_groups/${group.id}`, { name: "Leather", rule: "tags", tags: "leather, nubuck" }, params);
    const updated = await prisma.productGroup.findUniqueOrThrow({ where: { id: group.id } });
    expect([updated.rule, updated.tags, updated.collections]).toEqual(["tags", ["leather", "nubuck"], []]);

    expect(flash(await post(groupAction, `/app/product_groups/${group.id}`, { intent: "delete" }, params)).notice).toBe(
      "Product group deleted.",
    );
    expect(await prisma.productGroup.count()).toBe(0);
  });

  it("bad picker JSON and a missing rule value are validation errors, not crashes", async () => {
    await shopFor("groups-admin.myshopify.com");
    const res = await post(newGroupAction, "/app/product_groups/new", { name: "X", rule: "collections", collections_json: "{nope" });
    expect(statusOf(res)).toBe(422);
    expect(dataOf<{ errors: string[] }>(res).errors).toEqual(["Collections choose at least one"]);
  });

  it("a group in use isn't deleted, and plans/policies offer the shop's groups", async () => {
    const shop = await shopFor("groups-admin.myshopify.com");
    const group = await createProductGroupFor(shop, { name: "Sandals", rule: "product_type", productType: "Sandals" });
    await createWarrantyPolicyFor(shop, { name: "W", productGroupId: group.id });
    const params = { id: String(group.id) };

    const res = await post(groupAction, `/app/product_groups/${group.id}`, { intent: "delete" }, params);
    expect(flash(res).alert).toMatch(/used by a warranty policy/);
    expect(await prisma.productGroup.count()).toBe(1);
    expect((await get<Awaited<ReturnType<typeof groupLoader>>>(groupLoader, `/app/product_groups/${group.id}`, params)).usedBy).toBe("W");

    const form = await get<Awaited<ReturnType<typeof newPolicyLoader>>>(newPolicyLoader, "/app/warranty_policies/new");
    expect(form.groups.map((g) => g.id)).toEqual([group.id]);
  });

  it("another shop's group can't be seen, edited or deleted", async () => {
    await shopFor("groups-admin.myshopify.com");
    const other = await createShop();
    const theirs = await createProductGroupFor(other, { name: "Theirs" });
    const params = { id: String(theirs.id) };
    expect(statusOf(await get(groupLoader, `/app/product_groups/${theirs.id}`, params))).toBe(404);
    expect(statusOf(await post(groupAction, `/app/product_groups/${theirs.id}`, { name: "Mine" }, params))).toBe(404);
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: theirs.id } })).name).toBe("Theirs");
  });
});

describe("Care plans", () => {
  const careVariant = (id: string, price: string, title = "3-year Care") => ({
    "productVariant(": {
      productVariant: {
        id: `gid://shopify/ProductVariant/${id}`,
        title: "Default Title",
        price,
        product: { id: "gid://shopify/Product/800", title },
      },
    },
  });

  it("screens render, with refunds that need the merchant and the generated terms", async () => {
    const shop = await shopFor("care-admin.myshopify.com");
    const { plan } = await buildCare(shop);
    const item = await createItemFor(shop, { productTitle: "Boot", purchasedAt: daysAgo(1) });
    const cover = await createCover(careCoverFor(item, plan, {}));
    await prisma.cover.update({
      where: { id: cover.id },
      data: { status: "cancelled", usage: { refund: { action: "refund", status: "failed", error: "Archived" } } },
    });

    const list = await get<Awaited<ReturnType<typeof plansLoader>>>(plansLoader, "/app/care_plans");
    expect(list.attention[0].text).toMatch(/The automatic refund failed \(Archived\)/);
    expect(list.plans[0]).toMatchObject({ name: "2-year Care", sold: 1 });

    const params = { id: String(plan.id) };
    const show = await get<Awaited<ReturnType<typeof planLoader>>>(planLoader, `/app/care_plans/${plan.id}`, params);
    expect(show.stats[0]).toEqual(["Sold", "1"]);
    const edit = await get<Awaited<ReturnType<typeof editPlanLoader>>>(editPlanLoader, `/app/care_plans/${plan.id}/edit`, params);
    expect(edit.terms[edit.terms.length - 1]).toMatch(/does not affect, your statutory rights/);
    const fresh = await get<Awaited<ReturnType<typeof newPlanLoader>>>(newPlanLoader, "/app/care_plans/new");
    expect(fresh.values.name).toBe("2-year Care");
  });

  it("create a plan linked to the merchant's Care product", async () => {
    const shop = await shopFor("care-admin.myshopify.com");
    const admin = new FakeGraphql(careVariant("8001", "25.00"));
    signInAs(shop, { admin });
    const leather = await createProductGroupFor(shop, { name: "Leather", rule: "tags", tags: ["leather"] });

    const res = await post(newPlanAction, "/app/care_plans/new", {
      name: "3-year Care",
      shopify_variant_id: "gid://shopify/ProductVariant/8001",
      term_months: "36",
      offer_window_days: "30",
      active: ["0", "1"],
      excess: "5",
      "perks[priority]": ["0", "1"],
      product_group_id: String(leather.id),
      exclusions: "Suede wear",
    });

    const plan = await prisma.carePlan.findFirstOrThrow({ where: { name: "3-year Care" } });
    expect(flash(res)).toEqual({ path: `/app/care_plans/${plan.id}`, notice: "Care plan created." });
    expect([plan.shopifyProductId, plan.shopifyVariantId, plan.price.toNumber(), plan.termMonths, plan.excess.toNumber()]).toEqual([
      "800", "8001", 25, 36, 5,
    ]);
    expect(plan.perks).toEqual({ priority: true, trade_in_bonus_percent: 0 });
    expect(plan.productGroupId).toBe(leather.id);
    expect(admin.calls[0].variables).toEqual({ id: "gid://shopify/ProductVariant/8001" });
  });

  it("a Care product Shopify doesn't know is rejected", async () => {
    const shop = await shopFor("care-admin.myshopify.com");
    signInAs(shop, { admin: new FakeGraphql({ "productVariant(": { productVariant: null } }) });
    const res = await post(newPlanAction, "/app/care_plans/new", { name: "X", shopify_variant_id: "123", term_months: "12" });
    expect(statusOf(res)).toBe(422);
    expect(dataOf<{ errors: string[] }>(res).errors).toEqual(["We couldn't find that Care product in Shopify. Choose it again."]);
    expect(await prisma.carePlan.count()).toBe(0);
  });

  it("editing keeps the stored trade-in perk while trade-in is off", async () => {
    const shop = await shopFor("care-admin.myshopify.com");
    const { plan } = await buildCare(shop, { perks: { priority: false, trade_in_bonus_percent: 10 } });
    const params = { id: String(plan.id) };
    const res = await post(editPlanAction, `/app/care_plans/${plan.id}/edit`, {
      name: "2-year Care+",
      "perks[priority]": ["0", "1"],
      "perks[trade_in_bonus_percent]": "50",
    }, params);
    expect(flash(res).notice).toBe("Care plan saved.");
    const saved = await prisma.carePlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect([saved.name, saved.perks]).toEqual(["2-year Care+", { priority: true, trade_in_bonus_percent: 10 }]);
  });

  it("a sold plan is switched off, not deleted; an unsold one is deleted", async () => {
    const shop = await shopFor("care-admin.myshopify.com");
    const { plan } = await buildCare(shop);
    await createCover(careCoverFor(await createItemFor(shop, { purchasedAt: daysAgo(1) }), plan, {}));
    const params = { id: String(plan.id) };
    const res = await post(editPlanAction, `/app/care_plans/${plan.id}/edit`, { intent: "delete" }, params);
    expect(flash(res).notice).toBe("This plan has been sold, so it's been switched off rather than deleted.");
    expect((await prisma.carePlan.findUniqueOrThrow({ where: { id: plan.id } })).active).toBe(false);

    const unsold = await createCarePlanFor(shop);
    const gone = await post(editPlanAction, `/app/care_plans/${unsold.id}/edit`, { intent: "delete" }, { id: String(unsold.id) });
    expect(flash(gone).notice).toBe("Care plan deleted.");
  });

  it("another shop's plan can't be seen or edited", async () => {
    await shopFor("care-admin.myshopify.com");
    const other = await createShop();
    const { plan } = await buildCare(other);
    const params = { id: String(plan.id) };
    expect(statusOf(await get(planLoader, `/app/care_plans/${plan.id}`, params))).toBe(404);
    expect(statusOf(await post(editPlanAction, `/app/care_plans/${plan.id}/edit`, { intent: "delete" }, params))).toBe(404);
    expect(await prisma.carePlan.count()).toBe(1);
  });
});
