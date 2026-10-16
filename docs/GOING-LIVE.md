# Going live — wiring checklist & current state

**15-10-2026: moved to a new app.** The original app (client ID `6284fe18…`) could
no longer be found by the CLI, so a fresh **ShopCare** app was created in Partner org
*Hype Park* (client ID `35f17691b22cc66e2dfa8324395f96d6`). Its dev store isn't
chosen yet: `shopify app dev` asks on first run. The old app's leaked secret no
longer matters (that app isn't used). `.env` holds the new app's key/secret
(`shopify app env pull --env-file .env`).

Before that, the app was **wired to a live dev store** (Partner org *Hype Park*,
dev store **asamlabs.myshopify.com**). Embedded admin, App Proxy intake, and
order-history all work end-to-end. The one open item is full purchase history
(see "Pick up here" below).

---

## ▶ Pick up here (tomorrow): full purchase history needs `read_all_orders`

**Symptom:** the storefront repair form's step 1 shows "We couldn't find any
purchases on your account," even for a logged-in customer who has an order.

**Root cause (confirmed):** the default `read_orders` scope only exposes orders
from the **last 60 days**. The test customer's order (#1002, the Snowboard) is
from February — older than 60 days — so it's invisible. Orders within 60 days
*do* show.

**The fix — request `read_all_orders` (Shopify-gated scope):**
1. Partner Dashboard → Apps → **ShopCare → API access → Protected customer data access**
   → request access. Reason to give:
   *"Show customers their past purchases so they can request repairs — older items
   are the most likely to need repair."*
2. Wait for Shopify to grant it (it's reviewed; not instant).
3. Once granted, re-add the scope (it's **one line**, two places — a comment in the
   code marks it):
   - `config/initializers/shopify_app.rb` → `config.scope` (add `read_all_orders`)
   - `shopify.app.toml` → `[access_scopes] scopes` (add `read_all_orders`)
4. `shopify app deploy`, then re-open ShopCare in admin to approve the new permission.

⚠️ **Do NOT add `read_all_orders` before it's approved** — `shopify app dev` /
`deploy` will hard-error (`app_access └ read_all_orders ❌`) and break the preview.
We hit this and reverted it.

**To demo it sooner without approval:** place a *recent* order (within 60 days) for
your customer account — it will show up as a card immediately.

---

## Known dev-environment gotchas (already solved, but they recur)

- **App Proxy URL is NOT auto-updated by `shopify app dev`.** Only the app URL +
  OAuth redirects auto-update. The Cloudflare tunnel changes every restart, so each
  time you restart `shopify app dev` you must:
  ```sh
  # paste the new tunnel host shown by `shopify app dev`
  sed -i '' -E 's#https://[a-z0-9-]+\.trycloudflare\.com#https://NEW-HOST#g' shopify.app.toml
  shopify app deploy
  ```
  To avoid this forever, use a stable tunnel: `ngrok http 3000 --url=https://<static>.ngrok-free.app`
  then `shopify app dev --tunnel-url=https://<static>.ngrok-free.app:3000`, and deploy once.
- **Rails host authorization** — App Proxy requests arrive with the shop's Host
  header (`asamlabs.myshopify.com`). `config/environments/development.rb` now allows
  `.myshopify.com` (fixed; was returning "Blocked hosts" HTML that the form read as
  "couldn't reach the server").
- **`web` dev command** must be `bin/rails server` (no `-p ${PORT}`) — the CLI runs
  it without a shell, so `${PORT}` won't expand; Rails reads `ENV["PORT"]` itself.
- **New customer accounts + App Proxy `logged_in_customer_id`** — Shopify's docs
  (https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies)
  say the proxy sends the logged-in customer's id and leave it empty only when
  nobody is logged in; they don't distinguish classic and new customer accounts.
  Developers report it blank on some requests (and stale after logout) on new
  customer accounts, so the app doesn't rely on it alone. The theme blocks also
  send a token Liquid signs for `customer`: `customer_id`, `customer_ts`,
  `customer_sig` = HMAC-SHA256 of `"<id>:<ts>"` under a per-shop secret. The
  secret is created on install (AfterAuthenticateJob), kept encrypted on the
  Shop, and published as an app-data metafield on the app installation
  (`app.metafields.shopcare.customer_signing_key` in Liquid; not visible in the
  admin, the Storefront API or to other apps). Tokens last 24 hours, so a page
  rendered earlier (page cache, a tab left open) still works; an expired or
  tampered one means "logged out". `logged_in_customer_id` wins when present.
  A bare id from the browser is never accepted — Shopify signs whatever query
  the visitor sends. To rotate a shop's secret:
  `bin/rails runner 'Shopify::CustomerSigningKey.new(Shop.find_by!(shopify_domain: "x.myshopify.com")).rotate!'`
  (pages already open fall back to logged out until reloaded).
  After install, `shop.settings["customer_signing_key_published_at"]` should be
  set; if publishing failed, the next authenticate (admin load) retries. Still
  to check on the dev store: log in with a new customer account and confirm
  the repair form lists the customer's orders.

---

## Remaining wiring / go-live steps

### Credentials & run
- [x] Partner app **ShopCare** (Hype Park) linked; `.env` has its key/secret.
- Shopify CLI 3.86 needs a `package.json` at the app root (there's a minimal one with
  CLI shortcuts: `npm run dev`, `npm run deploy`). Without it, `config use` / `app info` fail.
- Flow trigger field `key`s may only contain letters and spaces (no hyphens or digits).
- [x] `shopify app dev` runs the Rails app; embedded admin loads.

### App Proxy (storefront) — works
- `/apps/repairs/intake` → `/proxy/intake` (create ticket; signature verified)
- `/apps/repairs/orders` → `/proxy/orders` (purchase history)
- `/apps/repairs/status` → `/proxy/status` (JSON for the **Repair status** block)
- `/apps/repairs/quotes/:token` (+ `/accept`, `/decline`) → `/proxy/quotes/…` (quote decision
  page, returned as `application/liquid` so it renders inside the theme)
- Subpath prefix `apps`, subpath `repairs`, proxy URL `https://<HOST>/proxy`.

### Theme App Extension (`extensions/repair-intake`)
- [x] **Repair request** block (3-step wizard: choose item → issue → details).
- [ ] Re-deploy after each change while the tunnel is current.

### Webhooks
- [ ] `orders/paid` registered from `config.webhooks` on boot → pay a test draft
      order → confirm `OrdersPaidJob` flips the ticket to `in_repair`.
- [ ] `orders/paid` for an ordinary sale → confirm an Item (with cover, if a
      warranty policy matches) appears under **Items**.
- [ ] `refunds/create` (new in Phase 1) → refund a line → the Item shows *Refunded*
      and its cover is cancelled. It's registered at runtime like `orders/paid`;
      restart the app once so `add_registrations` picks it up.

### Items + warranty (Phase 1)
- [ ] Create a warranty policy (admin → **Warranty**).
- [ ] **Items → Import recent orders** (also queued automatically the first time a
      shop authenticates). Only reaches back 60 days until `read_all_orders` is approved.

### Care plans (Phase 4)
- [ ] `shopify app deploy` adds the new scopes (`write_orders`, `write_discounts`) and the
      Flow trigger extensions (`extensions/shopcare-flow-*`); re-open ShopCare in admin
      to approve the new permissions.
- [ ] Create a Care product in Shopify (e.g. “2-year Care”, not physical), then link it in
      **Care plans → Add Care plan**.
- [ ] Add the **Care offer** block to the product template and the **Add Care to a
      purchase** block to a page; put that page's URL in Settings → Care plans.
- [ ] Buy a product with Care → the item shows Care cover; refund the product → the
      Care line is refunded (or a credit code issued, per Settings).
- [ ] Shopify Flow: build a workflow from “Care plan activated” → send email; check
      Settings → Recent notifications shows *Sent*.
- [ ] Klaviyo (optional): paste a private key with Events write access, send a test event.
- [ ] Optional hardening: a Cart validation Function to stop a Care product being
      bought on its own (nested lines already remove it with its parent).

### Trade-in (parked for V2 — skip for V1)
Off by default (`Shop#trade_in_enabled?`); the blocks and Flow trigger are out of the
extension (docs/ROADMAP.md §3.4). When it comes back:
- [ ] Deploy adds the `write_store_credit_account_transactions` scope and the
      “Trade-in status changed” Flow trigger; approve the new permission in admin.
- [ ] Create a trade-in program (**Trade-ins → Trade-in programs**).
- [ ] Add the **Trade-in offer** block next to Add to cart on the product template;
      add a trade-in with a purchase → after payment it appears under **Trade-ins** as *Requested*.
- [ ] Approve → receive → credit. Check the store credit shows on the customer
      (store credit needs **new customer accounts** for customers to spend it; otherwise
      set Settings → Trade-in to discount codes).
- [ ] Switch on the **Trade-in request button** app embed and send a trade-in request from it.

### Settings (in-app, per merchant)
- [ ] Set the repair-product **tag** or **collection** so the picker is populated.
- [ ] Set the quote email subject/message (Settings → Notifications), quote validity, repair
      order tag, and (optional) outbound webhook URL. Customers need nothing else: Shopify's own
      invoice email is the quote, from the store, to guests too. Send a test quote to yourself
      and check the "Decline here" link and Pay now.
- [ ] Staff alerts (recipe below): one Flow workflow per trigger you want emailed to the team.
- [ ] `shopify app deploy` replaces the old “Repair quote sent / accepted” triggers with
      **Repair quote paid** and **Repair quote expired** (the new one gets its `uid` on deploy);
      delete any workflow still using the old triggers.
- [ ] Production runs `ExpireQuotesJob` daily (`config/recurring.yml`) — make sure Solid Queue's
      scheduler is running.

### Production
- [ ] Object storage: `config/storage.yml` `:amazon` + AWS_* env, set
      `config.active_storage.service = :amazon` in production.
- [ ] Apply for protected customer data access (PII + orders) for the public app.

## Flow recipe: staff alerts for repair quotes

ShopCare's quote triggers carry no customer reference, so they fire for guests too.
For each of **Repair quote paid**, **Repair quote declined** and **Repair quote expired**:

1. Shopify admin → **Flow** → **Create workflow** → **Select a trigger** → search
   “Repair quote” → pick the trigger.
2. **Add action** → **Send internal email**. To: your workshop inbox. Subject, e.g.
   `Repair #{{ticketNumber}} quote paid — {{productTitle}}` (Flow's variable picker
   lists the trigger's fields: Ticket number, Product title, Customer name, Customer
   email, Quote total, plus Order name / Reason / Valid until).
3. Body, e.g.:
   ```
   {{customerName}} ({{customerEmail}}) paid {{quoteTotal}} — order {{orderName}}.
   Start the repair: open ShopCare → Tickets → #{{ticketNumber}}.
   ```
   Declined: `Reason: {{reason}}`. Expired: `Was valid until {{validUntil}}`;
   revise or resend the invoice from the ticket.
4. **Turn on workflow**. Check Settings → Recent notifications shows *Sent*.

Use Flow's variable picker rather than typing the names above: it inserts the exact
Liquid for each field.

## Still to build (offline-able)
- Product-context launch + eligibility rules for the intake form.
- Billing (`config.billing` scaffold is commented out in the initializer).
