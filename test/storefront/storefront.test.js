// The theme app extension's Liquid and JavaScript, run for real: blocks are
// rendered with liquidjs, the storefront scripts run in jsdom with a mocked
// fetch, and each test walks a customer journey. Ported from Rails
// test/storefront/storefront.test.js (a node script there; a Vitest project
// here: `npm run test:storefront`). The proxy responses mocked below are
// replayed against the real routes in test/integration/routes/extension-contract.test.ts.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import crypto from "node:crypto";
import { JSDOM, VirtualConsole } from "jsdom";
import { Liquid } from "liquidjs";
import { describe, it } from "vitest";

const EXT = path.join(import.meta.dirname, "../../extensions/repair-intake");
const engine = new Liquid({ root: [path.join(EXT, "snippets")], extname: ".liquid" });
// Shopify's hmac_sha256 filter: hex HMAC-SHA256 of the input under the key.
engine.registerFilter("hmac_sha256", (input, key) => crypto.createHmac("sha256", String(key)).update(String(input)).digest("hex"));
engine.registerTag("schema", { parse(token, remain) { this.tpl = []; const stream = this.liquid.parser.parseStream(remain); stream.on("tag:endschema", () => stream.stop()).on("template", () => {}).on("end", () => { throw new Error("no endschema"); }); stream.start(); }, render() { return ""; } });

function settingsFrom(file) {
  const src = fs.readFileSync(file, "utf8");
  const schema = JSON.parse(src.match(/{% schema %}([\s\S]*?){% endschema %}/)[1]);
  const settings = {};
  schema.settings.forEach((s) => { settings[s.id] = s.default; });
  return settings;
}

async function block(name, extraSettings = {}, ctx = {}) {
  const file = path.join(EXT, "blocks", name + ".liquid");
  const src = fs.readFileSync(file, "utf8");
  const settings = Object.assign(settingsFrom(file), extraSettings);
  // Shopify's global objects reach snippets rendered with {% render %}, so they're liquidjs globals.
  const globals = Object.assign({
    routes: { cart_add_url: "/cart/add", cart_change_url: "/cart/change", cart_url: "/cart", root_url: "/", account_login_url: "/account/login" },
    shop: { customer_accounts_enabled: true },
    request: { path: "/pages/repairs" }
  }, ctx.globals);
  return engine.parseAndRender(src, Object.assign({
    block: { id: name, settings, shopify_attributes: "" },
    customer: { id: 77, name: "Sarah", email: "sarah@example.com", default_address: { address1: "12 Bow Lane", city: "London", zip: "EC4M 9EU", country: "United Kingdom" } },
    product: { id: 10 }
  }, globals, ctx), { globals });
}

function setup(html, routes) {
  let navigatedTo = null;
  const virtualConsole = new VirtualConsole();
  // jsdom can't navigate; it reports the attempt instead.
  virtualConsole.on("jsdomError", (e) => { if (/navigation/.test(e.message)) navigatedTo = "navigated"; else console.error(e); });
  const dom = new JSDOM(`<!doctype html><html lang="en-GB"><body>${html}</body></html>`, { url: "https://shop.test/products/boot", runScripts: "outside-only", virtualConsole });
  const { window } = dom;
  const calls = [];
  window.fetch = (url, opts = {}) => {
    calls.push({ url, opts });
    const handler = routes.find(([pattern]) => url.includes(pattern));
    if (!handler) return Promise.reject(new Error("unmocked " + url));
    const body = typeof handler[1] === "function" ? handler[1](url, opts) : handler[1];
    return Promise.resolve({ ok: body.__status ? body.__status < 400 : true, json: () => Promise.resolve(body) });
  };
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  return { window, document: window.document, calls, run: (file) => window.eval(fs.readFileSync(path.join(EXT, "assets", file), "utf8")), navigated: () => navigatedTo };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const afterSearch = () => new Promise((r) => setTimeout(r, 300)); // past the search debounce
function click(window, el) { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }
function key(window, el, name) { el.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); }
function type(window, el, value) { el.value = value; el.dispatchEvent(new window.Event("input", { bubbles: true })); }

async function pdpJourney() {
  const productForm = `<section class="shopify-section"><form action="/cart/add" method="post" id="pf">
    <input type="hidden" name="id" value="100"><input name="quantity" value="1"><input name="properties[Engraving]" value="AB">
    <button type="submit">Add to cart</button></form>
    ${await block("care_offer")}</section>`;
  let cartBody = null;
  const env = setup(productForm, [
    ["/apps/repairs/care_plans", { ok: true, currency: "GBP", plans: [{ id: 1, name: "2-year Care", variant_id: "7001", price: "15.00", term_months: 24, benefits: ["Free repairs"], exclusions: ["Theft or loss"], terms: ["All repairs to your Boot for 2 years, except: theft or loss.", "This plan is in addition to, and does not affect, your statutory rights."] }] }],
    ["/cart/add.js", (url, opts) => { cartBody = JSON.parse(opts.body); return { items: [] }; }],
    ["/cart.js", { items: [] }]
  ]);
  let themeHandlerRan = false;
  env.document.getElementById("pf").addEventListener("submit", (e) => { themeHandlerRan = true; e.preventDefault(); });
  env.run("shopcare-pdp.js");
  const { document, window } = env;
  const care = document.querySelector("[data-care-offer]");
  // Server-rendered placeholders hold the space while the plans load.
  assert.strictEqual(care.hidden, false, "block visible while loading");
  assert.strictEqual(care.querySelectorAll(".shopcare-pdp__skeleton").length, 2, "placeholders rendered");
  await tick();

  assert.strictEqual(care.hidden, false, "care offer shown");
  assert.strictEqual(care.querySelectorAll(".shopcare-pdp__skeleton").length, 0, "placeholders replaced");
  assert.ok(!care.hasAttribute("aria-busy"));

  // No offers chosen → the theme's own Add to cart runs.
  document.getElementById("pf").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  assert.ok(themeHandlerRan, "theme handler untouched when nothing chosen");
  themeHandlerRan = false;

  // Care: Apple-style plan cards plus "No coverage".
  const planCards = care.querySelectorAll('[role="radio"]');
  assert.strictEqual(planCards.length, 2, "one plan card + no coverage");
  assert.match(planCards[0].textContent, /2-year Care.*Cover this product for 24 months.*£15 one-off.*Free repairs/s);
  const covered = planCards[0].querySelector("details");
  assert.match(covered.querySelector("summary").textContent, /What's covered/);
  assert.match(covered.textContent, /All repairs to your Boot for 2 years.*does not affect, your statutory rights\./s);
  click(window, covered.querySelector("summary"));
  assert.strictEqual(planCards[0].getAttribute("aria-checked"), "false", "opening the terms doesn't choose the plan");
  click(window, planCards[0]);
  assert.strictEqual(planCards[0].getAttribute("aria-checked"), "true");

  document.getElementById("pf").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await tick();
  assert.ok(!themeHandlerRan, "theme handler skipped when a plan is chosen");
  assert.ok(env.calls.every((c) => !/customer_id/.test(c.url)), "no customer id in proxy URLs");
  const [product, careLine] = cartBody.items;
  assert.deepStrictEqual(product.properties, { Engraving: "AB" });
  assert.deepStrictEqual(careLine, { id: 7001, quantity: 1, parent_id: 100, properties: { _shopcare_for: "100" } });
  assert.strictEqual(env.navigated(), "navigated", "no cart drawer: went to the cart");
}

const PLAN = { id: 1, name: "2-year Care", variant_id: "7001", price: "15.00", term_months: 24, benefits: ["Free repairs"], terms: [] };

// Dawn's product section: a payment-terms form (with an id, no button) comes
// before the product form, the variant id sits outside the form (form="…"),
// and the theme's cart drawer re-renders from bundled sections.
async function pdpDawn({ cartItems = [], cartAfterAdd = null, drawer = "dawn", choose = true } = {}) {
  const drawerHtml = {
    dawn: "<cart-drawer class=\"is-empty\"></cart-drawer>",
    generic: "<div id=\"CartDrawer\"></div>",
    // Shopify Horizon: a dialog component; its lines re-render on cart:update.
    horizon: "<cart-drawer-component><dialog><cart-items-component data-section-id=\"main-cart\"></cart-items-component></dialog></cart-drawer-component>",
    // A section-rendered drawer without a JS API of its own.
    sections: "<div id=\"shopify-section-sections--1__cart-drawer\" class=\"shopify-section\"><div data-cart-drawer>0 items</div></div>"
  }[drawer] || "";
  const html = `${drawerHtml}<section class="shopify-section">
    <form action="/cart/add" id="installment"><input type="hidden" name="id" value="100"></form>
    <product-form><form action="/cart/add" id="pf"><input name="quantity" value="2"><button type="submit" name="add">Add to cart</button></form></product-form>
    <input type="hidden" name="id" value="100" form="pf">
    ${await block("care_offer")}</section>`;
  const adds = [];
  const changes = [];
  const env = setup(html, [
    ["/apps/repairs/care_plans", { ok: true, currency: "GBP", plans: [PLAN] }],
    ["/cart/add.js", (url, opts) => { const body = JSON.parse(opts.body); adds.push(body); return { items: body.items.map((i, n) => ({ key: "k" + n, id: i.id, variant_id: i.id })), sections: { "cart-drawer": "<div id=\"CartDrawer\">2 items</div>" } }; }],
    ["/cart/change.js", (url, opts) => { const body = JSON.parse(opts.body); changes.push(body); return { items: [], sections: { "cart-drawer": "<div id=\"CartDrawer\">synced</div>" } }; }],
    ["?sections=", (url) => ({ "sections--1__cart-drawer": "<div id=\"shopify-section-sections--1__cart-drawer\" class=\"shopify-section\"><div data-cart-drawer>2 items</div></div>", __url: url })],
    ["/cart.js", () => ({ item_count: adds.length ? 2 : 0, items: adds.length && cartAfterAdd ? cartAfterAdd : cartItems })]
  ]);
  const { document, window } = env;
  const rendered = [];
  const events = [];
  const published = [];
  const cart = document.querySelector("cart-drawer");
  if (cart) {
    cart.getSectionsToRender = () => [{ id: "cart-drawer", selector: "#CartDrawer" }, { id: "cart-icon-bubble" }];
    cart.renderContents = (state) => rendered.push(state);
  }
  window.PUB_SUB_EVENTS = { cartUpdate: "cart-update" };
  window.publish = (name, data) => published.push([name, data]);
  const details = {};
  ["cart:refresh", "theme:cart:change", "cart:update"].forEach((name) => document.addEventListener(name, (e) => { events.push(name); details[name] = e.detail; }));
  const horizon = document.querySelector("cart-drawer-component");
  if (horizon) horizon.open = () => horizon.setAttribute("open", "");
  let themeAdds = 0;
  document.getElementById("pf").addEventListener("submit", (e) => { themeAdds++; e.preventDefault(); });
  env.run("shopcare-pdp.js");
  await tick();
  if (choose) click(window, document.querySelector('[data-care-offer] [role="radio"]'));
  document.getElementById("pf").requestSubmit();
  await tick();
  return { env, adds, changes, rendered, events, details, published, themeAdds, cart, horizon };
}

async function pdpDawnCart() {
  // The payment-terms form isn't hijacked; the product form is.
  const { env, adds, rendered, events, published, themeAdds, cart } = await pdpDawn();
  assert.strictEqual(themeAdds, 0, "theme's add skipped: ShopCare added both lines");
  assert.strictEqual(adds.length, 1);
  assert.deepStrictEqual(adds[0].items, [{ id: 100, quantity: 2, properties: {} },
    { id: 7001, quantity: 2, parent_id: 100, properties: { _shopcare_for: "100" } }]);
  assert.deepStrictEqual(adds[0].sections, ["cart-drawer", "cart-icon-bubble"], "asks for the drawer's sections");
  assert.strictEqual(rendered.length, 1, "drawer re-rendered");
  assert.strictEqual(rendered[0].key, "k0", "with the product line");
  assert.match(rendered[0].sections["cart-drawer"], /2 items/);
  assert.ok(!cart.classList.contains("is-empty"));
  assert.deepStrictEqual(events, ["cart:refresh", "theme:cart:change"]);
  assert.strictEqual(published[0][0], "cart-update");
  assert.strictEqual(env.navigated(), null, "stayed on the page");
}

// The cart already has the product (1) with its plan (1); the customer adds 2 more.
const COVERED_CART = [
  { key: "a", variant_id: 100, quantity: 1, properties: {} },
  { key: "b", variant_id: 7001, quantity: 1, properties: { _shopcare_for: "100" }, parent_relationship: { parent_key: "a" } }
];
const COVERED_AFTER_ADD = [Object.assign({}, COVERED_CART[0], { quantity: 3 }), COVERED_CART[1]];

async function pdpNoDuplicatePlan() {
  const { env, adds, changes, rendered, themeAdds } = await pdpDawn({ cartItems: COVERED_CART, cartAfterAdd: COVERED_AFTER_ADD });
  assert.strictEqual(themeAdds, 0, "ShopCare added the product itself");
  assert.deepStrictEqual(adds.map((a) => a.items), [[{ id: 100, quantity: 2, properties: {} }]], "no second plan line");
  assert.strictEqual(adds[0].sections, undefined, "sections come with the last request");
  assert.deepStrictEqual(changes, [{ id: "b", quantity: 3, sections: ["cart-drawer", "cart-icon-bubble"], sections_url: "/products/boot" }],
    "plan quantity set to the product line's");
  assert.strictEqual(rendered.length, 1);
  assert.strictEqual(rendered[0].key, "k0", "drawer shows the added product");
  assert.match(rendered[0].sections["cart-drawer"], /synced/, "with the cart after the quantity change");
  assert.strictEqual(env.navigated(), null);
}

async function pdpPlanFollowsWithoutChoosing() {
  const { adds, changes, themeAdds } = await pdpDawn({ cartItems: COVERED_CART, cartAfterAdd: COVERED_AFTER_ADD, choose: false });
  assert.strictEqual(themeAdds, 0, "a covered product's add is handled even with no card chosen");
  assert.strictEqual(adds.length, 1);
  assert.deepStrictEqual(changes.map((c) => [c.id, c.quantity]), [["b", 3]]);

  const uncovered = await pdpDawn({ choose: false });
  assert.strictEqual(uncovered.themeAdds, 1, "nothing chosen, no plan in the cart: the theme's own add");
  assert.strictEqual(uncovered.adds.length + uncovered.changes.length, 0);
}

async function pdpGenericDrawer() {
  const { env, adds, events } = await pdpDawn({ drawer: "generic" });
  assert.strictEqual(adds.length, 1);
  assert.strictEqual(adds[0].sections, undefined, "no Dawn drawer: no sections requested");
  assert.deepStrictEqual(events, ["cart:refresh", "theme:cart:change"], "cart events for the theme's drawer");
  assert.strictEqual(env.navigated(), null, "drawer present: no redirect");
}

async function pdpHorizonDrawer() {
  const { env, adds, events, details, horizon } = await pdpDawn({ drawer: "horizon" });
  await tick();
  assert.strictEqual(adds.length, 1);
  assert.strictEqual(adds[0].sections, undefined, "Horizon renders its own sections");
  assert.deepStrictEqual(events, ["cart:refresh", "theme:cart:change", "cart:update"]);
  assert.strictEqual(details["cart:update"].data.itemCount, 2, "Horizon's cart icon gets the cart's count");
  assert.strictEqual(details["cart:update"].sourceId, "shopcare");
  assert.ok(horizon.hasAttribute("open"), "Horizon's drawer opened");
  assert.strictEqual(env.navigated(), null, "no redirect");
}

async function pdpSectionDrawer() {
  const { env, adds } = await pdpDawn({ drawer: "sections" });
  await tick();
  assert.strictEqual(adds.length, 1);
  const call = env.calls.find((c) => c.url.includes("?sections="));
  assert.strictEqual(call.url, "/products/boot?sections=sections--1__cart-drawer", "Section Rendering API for the drawer's section");
  const wrapper = env.document.getElementById("shopify-section-sections--1__cart-drawer");
  assert.strictEqual(wrapper.querySelector("[data-cart-drawer]").textContent, "2 items", "drawer section re-rendered in place");
  assert.strictEqual(wrapper.querySelectorAll(".shopify-section").length, 0, "not nested in a second wrapper");
  assert.strictEqual(env.navigated(), null);
}

async function pdpNoDrawer() {
  const { env } = await pdpDawn({ drawer: "none" });
  assert.strictEqual(env.navigated(), "navigated", "nothing recognised: the cart page");
}

async function pdpNoPlans() {
  const env = setup(`<form action="/cart/add"><input type="hidden" name="id" value="100"><button type="submit">Add</button></form>${await block("care_offer")}`,
    [["/apps/repairs/care_plans", { ok: true, currency: "GBP", plans: [] }]]);
  env.run("shopcare-pdp.js");
  await tick();
  assert.strictEqual(env.document.querySelector("[data-care-offer]").hidden, true, "no plans: block hidden");
}

async function requestForm() {
  let posted = null;
  const env = setup(await block("repair_form", { status_url: "/pages/repair-status" }), [
    ["/apps/repairs/orders", { ok: true, logged_in: true, products: [{ product_id: "10", variant_id: "100", product_title: "Aria Boot", order_name: "#1042", order_id: "9", order_line_id: "55", item_id: 3,
      cover: { name: "12-month warranty", outcome: "Free repair", ends_at: "2027-03-12", statutory_rights: "This warranty is in addition to, and does not affect, your statutory rights." } }] }],
    ["/apps/repairs/intake", (url, opts) => { posted = { url, body: opts.body }; return { ok: true, ticket_id: 1 }; }]
  ]);
  env.run("repair-intake.js");
  await tick();
  const { document, window } = env;
  const root = document.querySelector("[data-repair-intake]");
  const visibleStep = () => [...root.querySelectorAll("[data-step]")].find((p) => !p.hidden).getAttribute("data-step");
  assert.strictEqual(visibleStep(), "1", "starts by choosing the item");
  assert.match(root.querySelector("[data-profile]").textContent, /Sarah.*sarah@example\.com.*12 Bow Lane, London, EC4M 9EU, United Kingdom/s, "profile panel");
  assert.strictEqual(root.querySelector("[data-find]").hidden, false, "logged in: the search is offered too");
  const card = root.querySelector(".repair-intake__card");
  assert.ok(card, "purchases listed");
  click(window, card);
  assert.match(root.querySelector("[data-selected-cover-note]").textContent, /does not affect, your statutory rights/);
  click(window, root.querySelector('[data-step="1"] [data-next]'));
  assert.strictEqual(visibleStep(), "2");

  click(window, root.querySelector('[data-step="2"] [data-next]'));
  assert.strictEqual(visibleStep(), "2", "needs a description");
  root.querySelector('[name="description"]').value = "Sole peeling";
  click(window, root.querySelector('[data-step="2"] [data-next]'));
  assert.strictEqual(visibleStep(), "3");
  root.querySelector("[data-repair-form]").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await tick();

  const body = Object.fromEntries(posted.body.entries());
  assert.ok(!("customer_id" in body), "never sends a bare customer id");
  assert.strictEqual(posted.url, "/apps/repairs/intake");
  assert.deepStrictEqual([body.order_line_id, body.item_id, body.description, body.customer_email], ["55", "3", "Sole peeling", "sarah@example.com"]);
  assert.match(root.querySelector("[data-confirmation]").textContent, /repair request has been received/);
  assert.strictEqual(root.querySelector("[data-confirmation]").hidden, false);
  assert.match(root.querySelector("[data-confirmation-ref]").textContent, /#1/);
  assert.deepStrictEqual([...root.querySelectorAll(".repair-intake__tracker-step")].map((li) => li.textContent), ["Requested", "Quoted", "In repair", "Returned"]);
  assert.strictEqual(root.querySelector("[data-status-link]").getAttribute("href"), "/pages/repair-status");
}

// A guest: log in (back to this page, classic and new customer accounts) or carry on.
async function loggedOutChoice() {
  const env = setup(await block("repair_form", {}, { customer: null }), []);
  env.run("repair-intake.js");
  await tick();
  const { document, window } = env;
  const root = document.querySelector("[data-repair-intake]");
  const login = root.querySelector("[data-login-link]");
  assert.strictEqual(login.textContent, "Log in to see your orders");
  assert.strictEqual(login.getAttribute("href"), "/account/login?return_url=%2Fpages%2Frepairs&return_to=%2Fpages%2Frepairs");
  assert.strictEqual(root.querySelector("[data-find]").hidden, true, "the search waits for the choice");
  assert.strictEqual(root.querySelector('[data-step="1"] [data-next]').closest(".repair-intake__actions").hidden, true, "no Next before the choice");
  assert.strictEqual(root.querySelector("[data-profile]"), null, "no profile");
  assert.ok(!env.calls.length, "no order history requested");

  click(window, root.querySelector("[data-continue-guest]"));
  assert.strictEqual(root.querySelector("[data-start]").hidden, true);
  assert.strictEqual(root.querySelector("[data-find]").hidden, false);
  assert.strictEqual(document.activeElement, root.querySelector("[data-find-input]"), "focus moves to the search");
  assert.strictEqual(root.querySelector('[data-step="1"] [data-next]').closest(".repair-intake__actions").hidden, false);

  const noAccounts = setup(await block("repair_form", {}, { customer: null, globals: { shop: { customer_accounts_enabled: false } } }), []);
  assert.strictEqual(noAccounts.document.querySelector("[data-login-link]"), null, "no login link when the shop has no customer accounts");
}

const PRODUCTS = [
  { product_id: "10", variant_id: "100", product_title: "Aria Boot", variant_title: "UK 7", order_name: "#1042", order_date: "2026-09-01", order_id: "9", order_line_id: "55", item_id: 3,
    cover: { kind: "care", name: "2-year Care", badge: "ShopCare – 2 year plan", outcome: "Free repairs", ends_at: "2028-09-01", statutory_rights: "This plan is in addition to, and does not affect, your statutory rights." } },
  { product_id: "11", variant_id: "110", product_title: "Trail Runner", order_name: "#1043", order_id: "10", order_line_id: "56", item_id: 4,
    cover: { kind: "warranty", name: "12-month warranty", badge: "12-month warranty", outcome: "Free repair", ends_at: "2027-03-12" } },
  { product_id: "12", variant_id: "120", product_title: "Derby Shoe", order_name: "#1001", order_id: "11", order_line_id: "57", item_id: 5,
    open_ticket: { id: 8, status: "assessing", status_label: "Assessing" } }
].concat([1, 2, 3, 4].map((n) => ({ product_id: "2" + n, product_title: "Sock " + n, order_name: "#90" + n, order_line_id: "6" + n })));

// Logged in: products with Care / warranty / no cover; an open repair blocks a second request.
async function profileCards() {
  const env = setup(await block("repair_form"), [["/apps/repairs/orders", { ok: true, logged_in: true, products: PRODUCTS }]]);
  env.run("repair-intake.js");
  await tick();
  const { document, window } = env;
  const root = document.querySelector("[data-repair-intake]");
  const cards = () => [...root.querySelectorAll("[data-history-grid] .repair-intake__card")];
  assert.strictEqual(cards().length, 6, "first page of products");
  const more = root.querySelector("[data-history-more]");
  assert.strictEqual(more.hidden, false);
  click(window, more);
  assert.strictEqual(cards().length, 7);
  assert.strictEqual(more.hidden, true, "nothing more to show");

  const [care, warranty, open] = cards();
  assert.strictEqual(care.querySelector(".repair-intake__badge--care").textContent, "ShopCare – 2 year plan");
  assert.match(care.textContent, /Covered until .+2028/);
  assert.doesNotMatch(care.textContent, / left/, "no allowance on Care");
  assert.strictEqual(warranty.querySelector(".repair-intake__badge--warranty").textContent, "12-month warranty");
  assert.match(warranty.textContent, /Until .+2027/);
  assert.strictEqual(open.querySelector(".repair-intake__badge--none").textContent, "No cover");
  assert.match(care.querySelector(".repair-intake__card-sub").textContent, /^#1042 · /);

  assert.strictEqual(open.getAttribute("aria-disabled"), "true");
  assert.strictEqual(open.querySelector(".repair-intake__badge--open").textContent, "Repair in progress (Assessing)");
  click(window, open);
  assert.strictEqual(root.querySelector("[data-selected]").hidden, true, "can't choose an item already being repaired");
  assert.match(root.querySelector("[data-repair-status]").textContent, /already open for Derby Shoe/);
  click(window, root.querySelector('[data-step="1"] [data-next]'));
  assert.strictEqual([...root.querySelectorAll("[data-step]")].find((p) => !p.hidden).getAttribute("data-step"), "1");

  click(window, care);
  assert.match(root.querySelector("[data-selected-cover]").textContent, /^ShopCare – 2 year plan · Covered until [^·]+$/);
  click(window, root.querySelector("[data-change-product]"));
  assert.strictEqual(root.querySelector("[data-history]").hidden, false, "Change goes back to the products");
  assert.strictEqual(root.querySelector("[data-h-item-id]").value, "");
}

// Name/SKU search over the catalogue: a combobox, picked with the keyboard.
async function catalogueSearch() {
  let posted = null;
  const env = setup(await block("repair_form", {}, { customer: null }), [
    ["/apps/repairs/catalog_search", (url) => (url.includes("q=aria") ? { ok: true, results: [
      { product_id: "10", product_title: "Aria Boot", image_url: "https://cdn/10.jpg", variants: [{ variant_id: "100", variant_title: "UK 7" }, { variant_id: "101", variant_title: "UK 8" }] },
      { product_id: "11", product_title: "Aria Sandal", variant_id: "110", sku: "SAN-1" }
    ] } : { ok: true, results: [] })],
    ["/apps/repairs/intake", (url, opts) => { posted = Object.fromEntries(opts.body.entries()); return { ok: true, ticket_id: 5 }; }]
  ]);
  env.run("repair-intake.js");
  await tick();
  const { document, window } = env;
  const root = document.querySelector("[data-repair-intake]");
  click(window, root.querySelector("[data-continue-guest]"));
  const input = root.querySelector("[data-find-input]");
  const list = root.querySelector("[data-find-list]");

  type(window, input, "a");
  await afterSearch();
  assert.strictEqual(env.calls.length, 0, "no search under 2 characters");
  type(window, input, "ar");
  type(window, input, "aria");
  await afterSearch();
  assert.strictEqual(env.calls.length, 1, "debounced: one search");
  assert.strictEqual(input.getAttribute("role"), "combobox");
  assert.strictEqual(input.getAttribute("aria-expanded"), "true");
  assert.strictEqual(input.getAttribute("aria-controls"), list.id);
  const options = [...list.querySelectorAll('[role="option"]')];
  assert.deepStrictEqual(options.map((o) => o.textContent), ["Aria Boot", "Aria Sandal · SAN-1"]);
  assert.match(root.querySelector("[data-find-count]").textContent, /2 products found/);

  key(window, input, "ArrowDown");
  key(window, input, "ArrowDown");
  key(window, input, "ArrowDown");
  assert.strictEqual(input.getAttribute("aria-activedescendant"), options[0].id, "wraps around");
  assert.strictEqual(options[0].getAttribute("aria-selected"), "true");
  key(window, input, "Enter");
  assert.strictEqual(list.hidden, true);
  assert.strictEqual(root.querySelector("[data-selected-title]").textContent, "Aria Boot");
  assert.strictEqual(root.querySelector("[data-selected-cover]").hidden, true, "a catalogue pick has no cover");
  const variant = root.querySelector("[data-variant-select]");
  assert.strictEqual(root.querySelector("[data-variant-pick]").hidden, false);
  variant.value = "101";
  variant.dispatchEvent(new window.Event("change"));

  click(window, root.querySelector('[data-step="1"] [data-next]'));
  root.querySelector('[name="description"]').value = "Heel worn";
  click(window, root.querySelector('[data-step="2"] [data-next]'));
  root.querySelector('[name="customer_email"]').value = "guest@example.com";
  root.querySelector("[data-repair-form]").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await tick();
  assert.deepStrictEqual([posted.product_id, posted.variant_id, posted.variant_title, posted.unverified_purchase, posted.item_id, posted.order_token],
    ["10", "101", "UK 8", "true", "", ""]);
}

// A guest finds their order by number + email; a mismatch is a generic not found.
async function orderLookup() {
  const lookups = [];
  let posted = null;
  const env = setup(await block("repair_form", {}, { customer: null }), [
    ["/apps/repairs/catalog_search", { ok: true, results: [] }],
    ["/apps/repairs/order_lookup", (url, opts) => {
      const body = Object.fromEntries(opts.body.entries());
      lookups.push(body);
      return body.email === "sarah@example.com"
        ? { ok: true, order_name: "#1042", order_token: "signed-token", products: [PRODUCTS[0]] }
        : { __status: 404, ok: false, error: "We couldn't find that order. Check the order number, and the email address you used at checkout." };
    }],
    ["/apps/repairs/intake", (url, opts) => { posted = Object.fromEntries(opts.body.entries()); return { __status: 422, ok: false, errors: ["We couldn't confirm that purchase. Please choose it again, or describe the item instead."] }; }]
  ]);
  env.run("repair-intake.js");
  await tick();
  const { document, window } = env;
  const root = document.querySelector("[data-repair-intake]");
  click(window, root.querySelector("[data-continue-guest]"));
  const input = root.querySelector("[data-find-input]");

  type(window, input, "#1042");
  await afterSearch();
  const first = root.querySelector('[data-find-list] [role="option"]');
  assert.strictEqual(first.textContent, "Find order #1042");
  key(window, input, "ArrowDown");
  key(window, input, "Enter");
  const lookup = root.querySelector("[data-lookup]");
  assert.strictEqual(lookup.hidden, false, "asks for the order's email");
  assert.match(lookup.textContent, /Email used for order #1042/);

  click(window, root.querySelector("[data-lookup-submit]"));
  assert.strictEqual(lookups.length, 0, "needs the email first");
  root.querySelector("[data-lookup-email]").value = "wrong@example.com";
  click(window, root.querySelector("[data-lookup-submit]"));
  await tick();
  assert.deepStrictEqual(lookups[0], { order_number: "1042", email: "wrong@example.com" });
  assert.match(root.querySelector("[data-repair-status]").textContent, /couldn't find that order/);
  assert.strictEqual(root.querySelector("[data-lookup-grid]").hidden, true, "a mismatch shows nothing");

  root.querySelector("[data-lookup-email]").value = "sarah@example.com";
  click(window, root.querySelector("[data-lookup-submit]"));
  await tick();
  const card = root.querySelector("[data-lookup-grid] .repair-intake__card");
  assert.match(card.textContent, /Aria Boot — UK 7.*#1042.*ShopCare – 2 year plan.*Covered until/s, "same card as order history");
  click(window, card);

  click(window, root.querySelector('[data-step="1"] [data-next]'));
  root.querySelector('[name="description"]').value = "Sole peeling";
  click(window, root.querySelector('[data-step="2"] [data-next]'));
  root.querySelector('[name="customer_email"]').value = "sarah@example.com";
  root.querySelector("[data-repair-form]").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await tick();
  assert.deepStrictEqual([posted.order_token, posted.order_line_id, posted.item_id, posted.order_id], ["signed-token", "55", "", ""],
    "the server re-verifies the line from its signed token; no item id from the browser");
  assert.match(root.querySelector("[data-repair-status]").textContent, /couldn't confirm that purchase/, "a rejected item is shown, not confirmed");
  assert.strictEqual(root.querySelector("[data-confirmation]").hidden, true);
}

// The details step: Name and Email share a row; each label's text is one element,
// so the required "*" can't wrap onto its own row and push Email down.
async function detailsRow() {
  const env = setup(await block("repair_form"), [["/apps/repairs/orders", { ok: true, products: [] }]]);
  const row = env.document.querySelector('[data-step="3"] .repair-intake__row');
  [...row.querySelectorAll(".repair-intake__label")].forEach((label) => {
    const kids = [...label.childNodes].filter((n) => n.nodeType === 1 || n.textContent.trim());
    assert.deepStrictEqual(kids.map((n) => n.nodeName), ["SPAN", "INPUT"], "label text in one span, then the input");
  });
  const css = fs.readFileSync(path.join(EXT, "assets", "repair-intake.css"), "utf8");
  assert.match(css, /\.repair-intake__row \{[^}]*align-items: end/, "row fields align to the bottom");
}

async function launcher() {
  const env = setup(await block("request_launcher"), [["/apps/repairs/orders", { ok: true, products: [] }]]);
  env.run("repair-intake.js");
  await tick();
  const { document, window } = env;
  const dialog = document.querySelector("[data-launcher-dialog]");
  assert.ok(!dialog.hasAttribute("open"));
  click(window, document.querySelector("[data-launcher-open]"));
  assert.ok(dialog.hasAttribute("open"), "dialog opens");
  const visible = [...document.querySelectorAll("[data-step]")].find((p) => !p.hidden).getAttribute("data-step");
  assert.strictEqual(visible, "1", "opens on choosing the item");
  click(window, document.querySelector("[data-launcher-close]"));
  assert.ok(!dialog.hasAttribute("open"), "dialog closes");
}

async function repairStatus() {
  const env = setup(await block("repair_status"), [["/apps/repairs/status", { ok: true, logged_in: true, tickets: [
    { id: 7, status_label: "Quoted", product_title: "Boot", cover: { kind: "care", name: "18-month Care", badge: "ShopCare – 18 month plan", ends_at: "2028-03-01" }, quotation: { status: "sent", currency: "GBP", subtotal: "24.00", review_url: "/apps/repairs/quotes/abc" } },
    { id: 8, status_label: "Quoted", product_title: "Shoe", quotation: { status: "paid", currency: "GBP", subtotal: "18.00" } },
    { id: 9, status_label: "Completed", product_title: "Sandal", cover: { kind: "warranty", name: "12-month warranty", badge: "12-month warranty", ends_at: "2027-03-12" } }
  ] }]]);
  env.run("shopcare-pdp.js");
  await tick();
  const { document } = env;
  const links = [...document.querySelectorAll("[data-status-list] a")];
  assert.strictEqual(links.length, 1, "a link only for the quote awaiting payment");
  assert.strictEqual(links[0].textContent, "Quote ready – review & pay");
  assert.strictEqual(links[0].getAttribute("href"), "/apps/repairs/quotes/abc");
  assert.strictEqual(document.querySelectorAll("[data-status-list] .shopcare__item").length, 3);
  const [care, , warranty] = document.querySelectorAll("[data-status-list] .shopcare__item");
  assert.strictEqual(care.querySelector(".shopcare__badge--care").textContent, "ShopCare – 18 month plan");
  assert.match(care.querySelector(".shopcare__badge-detail").textContent, /^Covered until .+2028$/);
  assert.strictEqual(warranty.querySelector(".shopcare__badge--warranty").textContent, "12-month warranty");
  assert.match(warranty.querySelector(".shopcare__badge-detail").textContent, /^Until .+2027$/);
}

// Add Care later: each plan row leads with the badge the cover will carry.
async function careLater() {
  let added = null;
  const env = setup(await block("care_add_later"), [
    ["/apps/repairs/care_offers", { ok: true, logged_in: true, currency: "GBP", items: [
      { item_id: 3, product_title: "Aria Boot", plans: [Object.assign({}, PLAN, { badge: "ShopCare – 2 year plan", offer_ends: "2026-11-01" })] }
    ] }],
    ["/cart/add.js", (url, opts) => { added = JSON.parse(opts.body); return { items: [{ key: "k0", id: 7001 }] }; }]
  ]);
  env.run("shopcare-pdp.js");
  await tick();
  const row = env.document.querySelector("[data-care-list] .shopcare__item-plan");
  assert.match(row.querySelector("span").textContent, /^ShopCare – 2 year plan · £15 · add by /);
  click(env.window, row.querySelector("button"));
  await tick();
  assert.deepStrictEqual(added.items, [{ id: 7001, quantity: 1, properties: { _shopcare_item: "3", Product: "Aria Boot" } }]);
}

// Logged-in customers' proxy URLs carry a token Liquid signs with the app's key
// (app.metafields.shopcare.customer_signing_key), in the form the app verifies
// (Shopify::CustomerToken). Guests, and shops without the key yet, get none.
async function signedCustomerToken() {
  const KEY = "k".repeat(64);
  const app = { metafields: { shopcare: { customer_signing_key: { value: KEY } } } };
  let posted = null;
  const env = setup(await block("repair_form", {}, { globals: { app } }), [
    ["/apps/repairs/orders", { ok: true, logged_in: true, products: [{ product_id: "10", variant_id: "100", product_title: "Aria Boot", order_name: "#1042", order_line_id: "55", item_id: 3 }] }],
    ["/apps/repairs/intake", (url) => { posted = url; return { ok: true, ticket_id: 1 }; }]
  ]);
  env.run("repair-intake.js");
  await tick();
  const ordersCall = env.calls.find((c) => c.url.startsWith("/apps/repairs/orders"));
  const params = new URL(ordersCall.url, "https://shop.test").searchParams;
  assert.strictEqual(params.get("customer_id"), "77");
  const age = Date.now() / 1000 - Number(params.get("customer_ts"));
  assert.ok(Math.abs(age) < 60, "timestamped now");
  const expected = crypto.createHmac("sha256", KEY).update(`77:${params.get("customer_ts")}`).digest("hex");
  assert.strictEqual(params.get("customer_sig"), expected, "signed as the app verifies it");
  const root = env.document.querySelector("[data-repair-intake]");
  ["data-intake-url", "data-lookup-url"].forEach((attr) => assert.ok(root.getAttribute(attr).endsWith("?" + params.toString()), attr));
  assert.strictEqual(root.getAttribute("data-catalog-url"), "/apps/repairs/catalog_search", "public search: no token");

  const { window } = env;
  click(window, root.querySelector(".repair-intake__card"));
  click(window, root.querySelector('[data-step="1"] [data-next]'));
  root.querySelector('[name="description"]').value = "Sole peeling";
  click(window, root.querySelector('[data-step="2"] [data-next]'));
  root.querySelector("[data-repair-form]").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await tick();
  assert.strictEqual(posted, "/apps/repairs/intake?" + params.toString(), "the request carries the token");

  const status = new JSDOM(await block("repair_status", {}, { globals: { app } })).window.document;
  assert.match(status.querySelector("[data-repair-status-list]").getAttribute("data-status-url"), /^\/apps\/repairs\/status\?customer_id=77&customer_ts=\d+&customer_sig=[0-9a-f]{64}$/);
  const later = new JSDOM(await block("care_add_later", {}, { globals: { app } })).window.document;
  assert.match(later.querySelector("[data-care-later]").getAttribute("data-offers-url"), /^\/apps\/repairs\/care_offers\?customer_id=77&/);

  const guest = new JSDOM(await block("repair_form", {}, { globals: { app }, customer: null })).window.document;
  assert.strictEqual(guest.querySelector("[data-repair-intake]").getAttribute("data-orders-url"), "/apps/repairs/orders", "guests: no token");
  const noKey = new JSDOM(await block("repair_status")).window.document;
  assert.strictEqual(noKey.querySelector("[data-repair-status-list]").getAttribute("data-status-url"), "/apps/repairs/status", "no key yet: no token");
}

// Shopify rejects the whole extension if a block schema breaks its rules.
// Trade-in is parked for V2: none of its blocks or endpoints may ship.
function schemaRules() {
  const dir = path.join(EXT, "blocks");
  fs.readdirSync(path.join(EXT, "assets")).concat(fs.readdirSync(path.join(EXT, "snippets"))).forEach((file) => {
    const dirName = file.endsWith(".liquid") ? "snippets" : "assets";
    assert.doesNotMatch(fs.readFileSync(path.join(EXT, dirName, file), "utf8"), /trade.?in/i, `${file} mentions trade-in`);
  });
  assert.ok(!fs.readdirSync(dir).some((f) => /trade_in/.test(f)), "no trade-in blocks");
  fs.readdirSync(dir).filter((f) => f.endsWith(".liquid")).forEach((file) => {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    const schema = JSON.parse(src.match(/{% schema %}([\s\S]*?){% endschema %}/)[1]);
    assert.ok(schema.name.length <= 25, `${file}: block name "${schema.name}" is over 25 characters`);
    assert.ok(["section", "body", "head"].includes(schema.target), `${file}: unknown target ${schema.target}`);
    const ids = schema.settings.map((s) => s.id);
    assert.strictEqual(new Set(ids).size, ids.length, `${file}: duplicate setting ids`);
    // Assets load through the schema, so Shopify puts the CSS in <head>.
    assert.doesNotMatch(src, /stylesheet_tag|<script/, `${file}: load assets via the schema`);
    [schema.stylesheet, schema.javascript].forEach((asset) => {
      assert.ok(asset && fs.existsSync(path.join(EXT, "assets", asset)), `${file}: missing asset ${asset}`);
    });
  });
}

describe("storefront: the theme extension in jsdom", () => {
  it("Block schemas follow Shopify's limits", schemaRules);
  it("PDP: Apple-style Care cards, added with the product; theme Add to cart untouched otherwise", pdpJourney);
  it("PDP: placeholders hold the space, and the block hides when there's no plan", pdpNoPlans);
  it("PDP (Dawn-like): product form found past the payment-terms form; drawer re-rendered, no redirect", pdpDawnCart);
  it("PDP: a plan already in the cart isn't added again; its quantity follows the product's", pdpNoDuplicatePlan);
  it("PDP: another unit of a covered product keeps its plan in step, chosen or not", pdpPlanFollowsWithoutChoosing);
  it("PDP: another theme's drawer gets cart events, no redirect", pdpGenericDrawer);
  it("PDP (Horizon-like): cart:update with the item count, drawer opened, no redirect", pdpHorizonDrawer);
  it("PDP: a section-rendered drawer is refreshed with the Section Rendering API", pdpSectionDrawer);
  it("PDP: no drawer recognised falls back to the cart page", pdpNoDrawer);
  it("Request form: repair journey submits to the intake endpoint, then shows the tracker", requestForm);
  it("Request form (logged out): log in back to this page, or continue without an account", loggedOutChoice);
  it("Request form (logged in): profile, Care / warranty / no-cover badges, show more, open repair blocked", profileCards);
  it("Request form: catalogue search (combobox, keyboard), filed as an unverified purchase", catalogueSearch);
  it("Request form: order + email lookup (match and mismatch); a rejected item isn't confirmed", orderLookup);
  it("Request form: details row aligned (Email no longer sits below Name)", detailsRow);
  it("App embed: button opens and closes the form", launcher);
  it("Repair status: a quote to review & pay, cover badges", repairStatus);
  it("Add Care later: plan rows carry the cover badge, added tagged to the item", careLater);
  it("Logged-in customer: proxy URLs carry a token signed the way the app verifies it", signedCustomerToken);
});
