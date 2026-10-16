# Going live: checklist and current state

ShopCare v2 (this repo, TypeScript on Netlify) replaces the Rails app. The
Shopify app itself doesn't change: it's the **ShopCare** app in Partner org
*Hype Park* (client ID `35f17691b22cc66e2dfa8324395f96d6`, created 15-10-2026
after the original app could no longer be found by the CLI). v2 links to it
with `shopify app config link` and is deployed with `shopify app deploy`; the
extension uids already belong to it. Its dev store is chosen on the first
`shopify app dev`; the earlier Rails wiring used **asamlabs.myshopify.com**.

The deploy steps (Neon, Resend, Netlify, Shopify) are in the README's
[Deploy](../README.md#deploy) section. This file is what to check once it's up.

---

## Scope change: `write_customers` needs re-approval

v2 asks for `write_customers` instead of `read_customers` (the rest of the
scopes are unchanged). It's needed so that unsubscribing from ShopCare's "Add
Care" marketing email also updates the customer's email marketing consent in
Shopify (`customerEmailMarketingConsentUpdate`), so the store and ShopCare
agree.

- `shopify app deploy` pushes the new scope list.
- Each store that already has ShopCare must **re-approve**: open ShopCare in
  the store's admin; Shopify shows the permission prompt (the
  `app/scopes_update` webhook records the change). Until it's approved, the
  unsubscribe still works inside ShopCare (suppression list) but Shopify's
  consent isn't updated.
- New installs get it in the normal install prompt.

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
      that page's URL in the block settings *and* in Settings → Notifications →
      Repair status page, so repair emails link to it).
- [ ] Logged-in customers on **new customer accounts**: confirm the repair
      form lists their orders (the blocks send a Liquid-signed customer token,
      because `logged_in_customer_id` can be blank there).

### Webhooks
- [ ] Pay a test repair invoice → the ticket moves to *In repair*, staff get
      the "quote paid" email.
- [ ] An ordinary sale → an Item (with cover, if a warranty policy matches)
      appears under **Items**.
- [ ] Refund a line → the Item shows *Refunded* and its cover is cancelled.
- [ ] Uninstall/reinstall on a dev store → the shop is marked uninstalled,
      then reactivated.

### Email (Resend)
- [ ] Sending domain verified; Settings → Notifications: "Notify staff at"
      and "Reply-to address" set; submit a test repair → the customer's
      "repair received" and the staff "new repair request" emails arrive.
- [ ] Resend webhook delivers to `/webhooks/email` (send to a bouncing address
      → it appears on the suppression list and is skipped next time).
- [ ] The "Add Care" offer goes out `care_offer_delay_days` after purchase
      (Settings → Notifications, default 7) to customers with email marketing
      consent; its unsubscribe link works.

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
      ticket goes straight to *In repair*.
- [ ] Optional: Flow (Settings → Notifications → Flow, **off by default**) and
      Klaviyo (private key with Events write access; "Send test").
- [ ] Optional hardening: a Cart validation Function to stop a Care product
      being bought on its own.

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

## Flow recipe: staff alerts for repair quotes (optional)

ShopCare emails staff itself ("Notify staff at"). If the merchant prefers Flow
(Settings → Notifications → Flow on), for each of **Repair quote paid**,
**Repair quote declined** and **Repair quote expired**:

1. Shopify admin → **Flow** → **Create workflow** → **Select a trigger** → search
   "Repair quote" → pick the trigger.
2. **Add action** → **Send internal email**. To: the workshop inbox. Subject, e.g.
   `Repair #{{ticketNumber}} quote paid — {{productTitle}}` (Flow's variable picker
   lists the fields: Ticket number, Product title, Customer name, Customer email,
   Quote total, plus Order name / Reason / Valid until).
3. Body, e.g. `{{customerName}} ({{customerEmail}}) paid {{quoteTotal}} — order
   {{orderName}}.` Declined: `Reason: {{reason}}`. Expired: `Was valid until
   {{validUntil}}`.
4. **Turn on workflow**, and switch ShopCare's own staff emails off for the same
   events to avoid duplicates. Check Settings → Recent notifications shows *Sent*.

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
