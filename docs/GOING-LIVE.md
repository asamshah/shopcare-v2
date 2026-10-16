# Going live: checklist and current state

ShopCare v2 (this repo, TypeScript on Netlify) replaces the Rails app. The
Shopify app itself doesn't change: it's the **ShopCare** app in Partner org
*Hype Park* (client ID `35f17691b22cc66e2dfa8324395f96d6`, created 15-10-2026
after the original app could no longer be found by the CLI). v2 links to it
with `shopify app config link` and is deployed with `shopify app deploy`; the
extension uids already belong to it. Its dev store is chosen on the first
`shopify app dev`; the earlier Rails wiring used **asamlabs.myshopify.com**.

The deploy steps (Neon, Netlify, Shopify) are in the README's
[Deploy](../README.md#deploy) section. This file is what to check once it's up.

---

## Scope change: needs re-approval

v2 asks for more than the Rails app (`shopify.app.toml` `[access_scopes]`,
mirrored in `SCOPES`):

- `write_customers` instead of `read_customers`: the customer repair-status
  metafield and the `shopcare-care-offer-eligible` customer tag
  (`tagsAdd` / `tagsRemove`).
- **`read_merchant_managed_fulfillment_orders`,
  `write_merchant_managed_fulfillment_orders`** (16-10-2026): ticket →
  **Mark returned** reads the repair order's fulfillment orders and calls
  `fulfillmentCreate` with tracking and `notifyCustomer: true`, so Shopify
  sends its Shipping confirmation
  ([fulfillmentCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate)
  needs `write_assigned_fulfillment_orders`,
  `write_merchant_managed_fulfillment_orders` or
  `write_third_party_fulfillment_orders`; repair orders are at the merchant's
  own location).

What to do:

- `shopify app deploy` pushes the new scope list; set the same `SCOPES` on
  Netlify.
- Each store that already has ShopCare must **re-approve**: open ShopCare in
  the store's admin; Shopify shows the permission prompt (the
  `app/scopes_update` webhook records the change). Until then **Mark
  returned** fails with an access error (fulfil the order in Shopify by hand
  meanwhile) and the customer tag isn't kept.
- New installs get them in the normal install prompt.

## Still open: full purchase history needs `read_all_orders`

**Symptom:** the storefront repair form's step 1 shows "We couldn't find any
purchases on your account" for a logged-in customer whose order is older than
60 days. The default `read_orders` scope only exposes the **last 60 days**.

**Fix (Shopify-gated scope):**
1. Partner Dashboard → Apps → **ShopCare → API access → Protected customer data
   access** → request access. Reason: *"Show customers their past purchases so
   they can request repairs: older items are the most likely to need repair."*
2. Wait for approval (reviewed, not instant).
3. Add `read_all_orders` to `[access_scopes] scopes` in `shopify.app.toml` and
   to `SCOPES` in the Netlify env, then `shopify app deploy` and re-approve in
   each store's admin.

⚠️ **Don't add `read_all_orders` before it's approved**: `shopify app dev` /
`deploy` hard-error (`app_access └ read_all_orders ❌`).

To demo sooner, place a recent order (within 60 days) for the customer account.

---

## After the first deploy

### Shopify config
- [ ] `npm run config:link` → the existing ShopCare app; URLs in
      `shopify.app.toml` point at the Netlify site; `npm run deploy`.
- [ ] Open ShopCare in the store admin, approve permissions. The first load
      creates the Shop row, publishes the customer signing key (app-data
      metafield) and queues the 60-day order backfill (Items shows the
      import status).
- [ ] `https://<store>.myshopify.com/apps/repairs/ping` → `{ "ok": true, "installed": true }`.

### App Proxy (storefront)
- `/apps/repairs/intake` → `/proxy/intake` (create ticket; 10 per hour per
  visitor, 300 per shop; photos must really be JPEG/PNG/WebP/HEIC)
- `/apps/repairs/orders` → `/proxy/orders` (purchase history)
- `/apps/repairs/status` → `/proxy/status` (JSON for the **Repair status** block)
- `/apps/repairs/quotes/:token` (+ `/decline`) → the quote review page,
  returned as `application/liquid` so it renders inside the theme
- Subpath prefix `apps`, subpath `repairs`, proxy URL `https://<site>/proxy`
  (unchanged from Rails, so the theme extension keeps working).

### Theme app extension (`extensions/repair-intake`)
- [ ] Add the **Repair request** block (and **Repair status** on a page; put
      that page's URL in the block settings *and* in Settings → Emails →
      Repair status page, so the order confirmation links to it). Customers
      follow their repairs there (no status emails): the step tracker, the
      postage slip and their Care credit codes.
- [ ] Logged-in customers on **new customer accounts**: confirm the repair
      form lists their orders (the blocks send a Liquid-signed customer token,
      because `logged_in_customer_id` can be blank there).

### Webhooks
- [ ] Pay a test repair invoice → the ticket moves to *Awaiting item*; the
      customer's Shopify order confirmation has the ShopCare section (see
      Emails below) and staff get Shopify's "New order" notification.
- [ ] An ordinary sale → an Item (with cover, if a warranty policy matches)
      appears under **Items**.
- [ ] Refund a line → the Item shows *Refunded* and its cover is cancelled.
- [ ] Uninstall/reinstall on a dev store → the shop is marked uninstalled,
      then reactivated.

### Emails (Shopify sends them)

ShopCare sends no email. Check each one in a dev store:

- [ ] **Order confirmation snippet**: Settings → Emails → **Copy snippet**
      (or setup step 4), then Shopify → Settings → Notifications → Customer
      notifications → **Order confirmation** → Edit code → paste (e.g. above
      the order summary) → Save. Shopify's "Send test email" uses a sample
      order without ShopCare's attributes, so the section stays hidden there:
      test with a real repair order.
- [ ] **Quote**: Send quote → Shopify's draft-order invoice arrives (guests
      too), with the validity and the decline link.
- [ ] **Paid repair** → the order confirmation shows "Your repair #…", the
      workshop address, the posting instructions and **Download your postage
      slip** (opens the PDF; the link works until the quote's validity + 30
      days). With the item already marked received it says so instead.
- [ ] **£0 covered repair** (completed with `draftOrderComplete`, marked as
      paid) → the customer gets the order confirmation with the same section.
      Shopify documents that marking a draft order as paid sends it
      ([Accepting payment](https://help.shopify.com/en/manual/fulfillment/managing-orders/create-orders/get-paid));
      confirm it on the dev store. If a store doesn't send it, resend the
      confirmation from the order in Shopify; the Repair status block links
      the slip either way.
- [ ] **Care**: buy a product with Care (and, logged in, add Care to a past
      purchase) → the order confirmation's Care section names the plan, the
      product and the end date, with the statutory rights sentence.
- [ ] **Mark returned** with a tracking number → Shopify's **Shipping
      confirmation** arrives with the tracking link; the ticket is completed.
      (Repair lines don't require shipping; confirm the shipping
      confirmation is sent for them on the dev store.)
- [ ] **Staff**: Shopify → Settings → Notifications → Staff notifications →
      **New order** on, so paid repairs reach the workshop. Everything else is
      under **Needs attention** on the Tickets home (new requests, declined /
      expired quotes, items not posted after N days, received items not
      started).
- [ ] **Add Care offer**: N days after purchase (Settings → Emails, default
      7) eligible customers carry the `shopcare-care-offer-eligible` tag;
      create a Shopify Email campaign (or automation) for that segment. Buying
      Care removes the tag at once; the window ending removes it the next day.
- [ ] Optional: Flow (Settings → Emails, **off by default**; recipes below)
      and Klaviyo (private key with Events write access; "Send test").

### Items + warranty
- [ ] Create a warranty policy (admin → **Warranty**).
- [ ] **Items → Import recent orders** (also queued on first install; 60 days
      until `read_all_orders` is approved).

### Care plans
- [ ] Create a Care product in Shopify (e.g. "2-year Care", not physical), then
      link it in **Care plans → Add Care plan**.
- [ ] Add the **Care offer** block to the product template and the **Add Care
      to a purchase** block to a page; put that page's URL in Settings → Care plans.
- [ ] Buy a product with Care → the item shows Care cover; refund the product →
      the Care line is refunded (or a credit code issued, per Settings).
- [ ] A covered repair: the £0 quote completes itself (no invoice) and the
      ticket moves to *Awaiting item* (Shopify's order confirmation carries
      the postage slip link), or straight to *In repair* if the item was
      already marked received.
- [ ] A Care credit code (refund with Settings → Care → credit code) shows on
      the item page for staff to share and on the customer's Repair status
      page; it isn't emailed.
- [ ] Optional hardening: a Cart validation Function to stop a Care product
      being bought on its own.

### Postage slips (customer posts the item; they pay the postage in V1)
- [ ] Settings → Repairs → **Workshop address** (name, address, town,
      postcode, country) and, optionally, **Posting instructions**. Without the
      address the order confirmation has no slip link and the ticket page
      links to Settings.
- [ ] Pay a test quote as a **guest** → the order confirmation's "Download
      your postage slip" opens the PDF through
      `/apps/repairs/tickets/:id/postage-slip`; print it (A4): the label's
      address, the repair number and the packing slip's QR code (opens the
      ticket in the admin) are right.
- [ ] As a **logged-in** customer, the Repair status block shows
      "Download postage slip" while the repair awaits the item.
- [ ] Ticket page → **Mark received** → status *Received* (the Repair status
      block shows it; no email); **Download postage slip** works while
      awaiting the item.
- [ ] The slip prints Latin text (accents, Polish, Czech, Vietnamese, …);
      Greek, Cyrillic, CJK or emoji in a name or address print as "?".

### Workshop (parts)
- [ ] Settings → Workshop on; import parts (CSV); link repair services to
      their recipes; complete a test ticket → stock is taken and the ticket's
      costs recorded.

### Trade-in (parked for V2: skip for V1)
Off by default (`settings.trade_in_enabled`); the storefront endpoints answer
"not available" even with the flag on (the storefront submission isn't
ported), and the blocks and Flow trigger are out of the extension. The staff
screens and workflow (approve → receive → credit) are ported. When it comes
back: port `TradeIns::Submission` + the two proxy endpoints, create a
trade-in program, add the **Trade-in offer** block, and remember store credit
needs **new customer accounts** (otherwise use discount codes).

### Settings (in-app, per merchant)
- [ ] Repair-product **tag** or **collection**, so the picker is populated.
- [ ] Quote validity, repair order tag, optional outbound webhook URL.
      Shopify's own invoice email is the quote (to guests too). Send a test
      quote to yourself and check the "Decline here" link and Pay now.
- [ ] Unpaid quotes expire daily (`netlify/functions/daily-expire-quotes.mts`);
      the scheduled functions show under Netlify → Functions.

### Production
- [ ] Apply for protected customer data access (PII + orders) for the public app.
- [ ] Netlify Blobs holds photos and exports (nothing to configure on Netlify).

## Flow recipes (optional)

ShopCare works without Flow. For merchants who want emails ShopCare doesn't
send: Settings → Emails → **Send ShopCare events to Shopify Flow** on, then in
Shopify admin → **Flow** → **Create workflow** → **Select a trigger** →
search "ShopCare" (or the trigger name). Flow's variable picker lists each
trigger's fields.

| Trigger | Fields | Suggested action |
|---|---|---|
| **Repair request submitted** (staff alert) | Ticket number, Product title, Customer name, Customer email, Description, Admin URL | **Send internal email** to the workshop: `New repair #{{ticketNumber}}: {{productTitle}}`, body `{{customerName}} ({{customerEmail}}): {{description}} {{adminUrl}}` |
| **Repair quote paid** (staff alert) | Ticket number, Product title, Customer name, Customer email, Quote total, Order name | Send internal email (Shopify's "New order" staff notification also covers it) |
| **Repair quote declined** (staff alert) | … + Reason | Send internal email: `Quote declined for #{{ticketNumber}}: {{reason}}` |
| **Repair quote expired** (staff alert) | … + Valid until | Send internal email: revise and resend from the ticket |
| **Customer data request** (staff alert) | Request ID, Customer, Records found, Download URL, Admin URL | Send internal email to whoever answers privacy requests |
| **Add Care offer** (customer) | Product title, Care plan, Care price, Offer ends, Add Care URL | Shopify Messaging → **Send marketing email** (sends only to customers subscribed to email marketing) with a template linking `{{addCareURL}}` |
| **Repair status changed** (customer) | Ticket number, Status, Product title | Optional customer email of your own, e.g. a condition on Status = "Ready" |
| **Care activated** / **Care credit issued** (customer) | Care plan, Product title, Cover ends / Credit code, Credit amount, Credit expires | Optional customer email (the order confirmation already covers Care; credit codes show on the Repair status page) |

Staff alerts carry no customer reference, so they fire for guests too.
"Send internal email" can't take the recipient from a variable
([Send internal email](https://help.shopify.com/en/manual/shopify-flow/reference/actions/send-email)).
Check Settings → Recent notifications shows *Sent* for the Flow deliveries.
Flow template extensions (`flow_template`) need workflows exported from the
Flow app as `.flow` files
([Create a Flow template](https://shopify.dev/docs/apps/build/flow/templates/create-a-template)):
export these recipes from the dev store to ship them as templates.

## Known dev-environment gotchas

- **App Proxy URL is not auto-updated by `shopify app dev`** (only the app URL
  and OAuth redirects are). The tunnel changes every restart, so update
  `[app_proxy].url` and `shopify app deploy`, or use a stable tunnel:
  `shopify app dev --tunnel-url=https://<static>.ngrok-free.app:3000`.
- **react-router is pinned at 7.18.2**: 7.18.3+ rejects action POSTs under the
  dev tunnel (README → Gotchas).
- **New customer accounts and `logged_in_customer_id`**: may be blank or
  stale; the blocks also send a Liquid-signed token (`customer_id`,
  `customer_ts`, `customer_sig`, HMAC under a per-shop key published as an
  app-data metafield on install; 24 h). `logged_in_customer_id` wins when present.

## Still to build

- Product-context launch + eligibility rules for the intake form.
- Billing (pricing proposal in docs/ROADMAP.md §6).
- Storefront trade-in (V2) and storefront registration (`Items::RegistrationSubmission`).
