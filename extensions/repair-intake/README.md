# ShopCare storefront — Theme App Extension

Blocks and an app embed the merchant adds in the theme editor. Everything talks
to the app through the **signed App Proxy** (`/apps/repairs/*` → `/proxy/*`).

## Product page (upsells in the Add to cart journey, laid out after Apple's)
| Block | What it does |
|---|---|
| **Care offer** | “Care coverage. Peace of mind in every plan.” One card per Care plan (name, cover period, price, benefits, and a **What's covered** panel with the plan's generated terms, ending with the statutory rights sentence) plus **No Care coverage**. The chosen plan is added as a nested cart line under the product (`_shopcare_for`). |

Colours and fonts come from the theme (see “Looks native in any theme” below);
an optional “Selected colour” overrides the theme's button colour for the chosen
card. It registers with an Add to cart coordinator (`assets/shopcare-pdp.js`)
on the section's product form (the `/cart/add` form with a variant `id` and a
submit button, so Dawn's payment-terms form is skipped). With nothing chosen
(and no plan for that variant already in the cart), the theme's own Add to cart
runs untouched. With a plan chosen, Add to cart sends the product and the plan
in one `/cart/add.js` call.

**Another unit of a covered product.** If the cart already has a plan for the
variant (`_shopcare_for`, read when the block loads and re-checked on submit),
no second plan line is added. Shopify removes a nested line with its parent
but doesn't change its quantity when the parent's changes, so ShopCare adds the
product itself, reads `/cart.js` back and sets the plan line's quantity to its
parent line's with `/cart/change.js` — whether or not a card was chosen.

**Showing the cart afterwards** (`showCart`), the way the theme would:
`cart:refresh`, `theme:cart:change` and Dawn's `cartUpdate` pub/sub always go
out; then the first of these that matches —
1. Dawn family: `<cart-drawer>` / `<cart-notification>` re-render from the
   sections bundled with the cart request;
2. Shopify Horizon: `<cart-drawer-component>` gets a `cart:update` event (the
   cart, its `item_count` for the header bubble) and is opened;
3. any other drawer (`[data-cart-drawer]`, an id containing `cart-drawer`,
   `#CartDrawer`, `.cart-drawer`, `<cart-drawer>`): the theme sections it sits
   in are re-fetched with the Section Rendering API (`?sections=`) and swapped
   in place; a drawer outside a section just gets the events;
4. nothing recognised: the cart page.

Verified by the jsdom tests (`test/storefront`) against Dawn-like, Horizon-like,
section-rendered and generic markup only. **No real theme has been verified
yet** — check Dawn, Horizon and the pilot's theme on a dev store before launch.

The block renders server-side placeholders, so the page doesn't jump when the
plans arrive; it hides if the product has none.

Trade-in is parked for V2: its blocks were removed from this extension (see
docs/ROADMAP.md §3.4 for where they live in git).

## Requests
| Block / embed | What it does |
|---|---|
| **Repair request** (page block) | Your product → the issue + photos → your details → confirmation with a status tracker (below). |
| **Repair request button** (app embed) | A floating button on every page that opens the form in a dialog. Theme settings → App embeds. |

Both render `snippets/shopcare_request_form.liquid` and run `assets/repair-intake.js`.

**1. Your product**
- **Logged out:** two choices. *Log in to see your orders* links to the theme's
  `routes.account_login_url` with `return_url` (classic customer accounts) and
  `return_to` (new customer accounts) set to this page; it's hidden if the shop
  has no customer accounts. *Continue without an account* opens the search.
- **Logged in:** a profile panel (name, email, default address, from Liquid) and
  **Your products**: cards from their order history plus registered products
  (`/orders`), six at a time with **Show more**. Each card shows the image,
  product and variant, order number and date, and a cover badge — Care reads
  “ShopCare – 2 year plan” (months when the term isn't whole years, e.g.
  “ShopCare – 18 month plan”) over “Covered until …”, the warranty its name
  (“12-month warranty”) over “Until …”, or **No cover**. The badge text comes
  from the app (`cover.badge`; the “ShopCare” brand is `CarePlan::BADGE_BRAND`). An item with a repair still
  open shows “Repair requested” / “Repair in progress” and can't be chosen.
- **Find the product you bought** (everyone; for logged-in customers it's “Can't
  see it?”): one box for a **product name, SKU or order number**. A combobox
  (`role="combobox"` + `listbox`, ↑/↓/Enter/Esc, result count announced),
  searching from 2 characters, debounced, up to 10 catalogue results
  (`/catalog_search`). Something that looks like an order number also offers
  **Find order #1042**: guests then give the email used for the order, and both
  must match (`/order_lookup`); logged-in customers only find their own orders.
  The order's lines appear as the same cards, with their cover.
- **I can't find it: describe it instead** — free-text product and optional
  order number, the last resort.

A catalogue pick is filed as an **unverified purchase** with no cover (staff can
link the real item later); a variant can optionally be chosen. An order line or
purchase links the real item and its cover. The browser never vouches for an
item: on submit the server re-checks it (the customer's own items, or the signed
token a guest's order lookup returned), refuses anything it can't verify, and
refuses a second request while the item's repair is open.

**2. The issue** (description, photos) and **3. Your details** (name, email, phone,
return address; prefilled from the customer's account and editable). Each label's
text is one element, so a required “*” can't wrap and push Email below Name.

**Confirmation:** the reference number, a tracker (Requested → Quoted → In repair →
Returned) and, if the block's **Repair status page** setting is set, a “Track your
repair” link.

## Other blocks
- **Add Care to a purchase** — add a Care plan to something already bought, within the plan's offer window (`_shopcare_item`). Each plan row leads with its badge (“ShopCare – 2 year plan · £15 · add by …”).
- **Repair status** — a logged-in customer's repairs, each with the cover badge it was raised under, and "Quote ready – review & pay"
  (the quote's review page) while a sent quote awaits payment. Once it's paid (or covered) and we're waiting for the item,
  "Download postage slip" opens the PDF to print: an address label for the parcel and a packing slip for inside.

The quote review page itself isn't a block: `/apps/repairs/quotes/:token` returns
Liquid, so Shopify renders it inside the theme (lines, total, expiry, **Pay now** —
the draft order's invoice — and **Decline** with an optional reason). Customers
reach it from the Shopify invoice email ("Decline here: …") and the status block.

## Looks native in any theme
The CSS sets no colours of its own. Text, borders and panels are mixed from
`currentColor` (`color-mix(in srgb, currentColor N%, transparent)`), so the blocks
follow the section's colour scheme, light or dark. Where a Dawn-family theme
exposes `--color-button` etc., the selected state uses it; otherwise
`currentColor`. Errors use `--shopcare-error`, defaulting to a red mixed 70/30
with the text colour (darker on light schemes, lighter on dark), plus a leading
bar and `role="alert"`. Buttons carry the theme's `button` / `button--secondary`
classes and links `link`; ShopCare's own fallback styles have zero specificity
(`:where()`), so the theme wins. Fonts, sizes and weights inherit; spacing uses
`em` and logical properties, so RTL works. Inputs keep ShopCare's markup (Dawn's
`field__input` needs its floating-label wrapper) with transparent, inherited styles.

## How it connects
```
Repair request      GET  /apps/repairs/orders            → /proxy/orders          (logged in: products + cover + open repair)
                    GET  /apps/repairs/catalog_search    → /proxy/catalog_search  (name / SKU; public catalogue facts; rate-limited)
                    POST /apps/repairs/order_lookup      → /proxy/order_lookup    (order no. + email, or own orders; rate-limited)
                    POST /apps/repairs/intake            → /proxy/intake
Care                GET  /apps/repairs/care_plans        → /proxy/care_plans
                    GET  /apps/repairs/care_offers       → /proxy/care_offers
Repair status       GET  /apps/repairs/status            → /proxy/status
Postage slip        GET  /apps/repairs/tickets/:id/postage-slip → /proxy/tickets/:id/postage-slip (PDF; signed link or the owner)
Quote decision      GET  /apps/repairs/quotes/:token     → /proxy/quotes/:token (+ POST accept / decline)
Cart                POST /cart/add.js                    (Shopify Cart AJAX API)
```

When the shopper is logged in, Shopify adds `logged_in_customer_id`. It has been
reported blank (or stale) on new customer accounts, so the blocks also put a
signed token on the customer's proxy URLs (`snippets/shopcare_customer_query`):
`customer_id`, `customer_ts` and `customer_sig` = `hmac_sha256` of
`"<id>:<ts>"` under the shop's secret, read in Liquid from the app-data
metafield `app.metafields.shopcare.customer_signing_key`. The app verifies it
(constant-time, 24-hour lifetime) and uses it only when `logged_in_customer_id`
is empty. A bare id from the browser is never accepted: Shopify signs whatever
query the visitor sends (see docs/GOING-LIVE.md).

Catalogue search and order lookup are rate-limited per shop + visitor IP and
per shop (a fixed window counted in Rails.cache). Every order-lookup miss —
wrong number, wrong email, someone else's order — returns the same “not found”.

## Testing
`test/storefront` renders these blocks with liquidjs and runs the scripts in
jsdom against mocked endpoints (`cd test/storefront && npm ci && npm test`).

## Wiring required (needs the live app)
1. App Proxy: prefix `apps`, subpath `repairs`, URL `https://<app-host>/proxy` (`shopify.app.toml`).
2. Deploy the extension (`shopify app deploy`) — **only with explicit approval.**
3. In the theme editor: add **Care offer** to the product template, above the
   Add to cart button; add **Repair request** to a page, and/or switch on its
   app-embed button. Set its **Repair status page** to the page with the
   **Repair status** block.
