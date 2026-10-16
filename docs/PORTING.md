# Porting ShopCare from Rails to TypeScript

Source of truth: the Rails app at git tag **`rails-reference`** (commit
`c8ea3ec`) in `../shopcare`. Every file under `app/` and `test/` at that tag is
listed below, with its planned module here. `extensions/`, `parked/` and
`docs/` were copied from the tag unchanged.

Status values: `todo` → `wip` → `done` (ported and its tests ported), or
`deferred` (deliberately not ported yet; the note says why). Update the row
in the same commit as the code. At the final integration every row is `done`
or `deferred`.

## Conventions

| Rails | ShopCare v2 |
|---|---|
| ActiveRecord model + validations | Prisma model in `prisma/schema.prisma` + `app/models/<name>.server.ts` (validation, scopes, state transitions as functions) |
| `app/services/<ns>/<name>.rb` | `app/services/<ns>/<name>.server.ts` (plain functions/classes; dependencies such as the Admin API client passed in, as in Rails `api:` kwargs) |
| Admin controller + ERB views | `app/routes/app.<area>*.tsx` (loader/action + Polaris web components) |
| `Proxy::*Controller` | `app/routes/proxy.<path>.tsx`, `authenticate.public.appProxy` |
| ActiveJob / Solid Queue | `app/jobs/<name>.server.ts` registered in `app/jobs/registry.server.ts`, run by the Netlify Background Function (see `docs/BACKGROUND-WORK.md`) |
| `config/recurring.yml` | Netlify Scheduled Function in `netlify/functions/` that calls `enqueue()` |
| ActiveStorage | `app/lib/storage.server.ts` (Netlify Blobs) + a key column |
| `encrypts :field` | `app/lib/encryption.server.ts` (AES-256-GCM, context = `"Model.field"`) |
| `Rails.cache` | Nothing is shared between function instances: the Postgres `cache_entries` table (`PostgresCache`, the default `ShopifyCache`), or the CDN for public responses |
| Minitest + fixtures + mocha | Vitest; `test/support/factories.ts` builders; fakes passed in as dependencies (`vi.fn()` for one-off mocks) |
| Model/service tests that touch the DB | `test/integration/**` (real Postgres, truncated per test) |
| Pure logic tests | `test/unit/**` (never touch the database: the unit project passes with Postgres down) |
| Shopify ids (`shopify_customer_id`, order/line/variant ids) | Strings (the numeric part of the GID) everywhere, never JS numbers; webhook payload ids are read from `admin_graphql_api_id` (JSON.parse would round ids past 2^53). The one exception is Flow's numeric `customer_id` |
| Pure helpers shared across layers (GIDs, customer token, signing) | `app/lib/*` (`gid.ts`, `customer-token.server.ts`, `signing.server.ts`) |
| `Shopify::AdminApi` and every Admin API call in a service | `app/shopify/*.server.ts`: plain functions taking an `AdminGraphqlClient` (`admin` from `authenticate.admin`, or `adminClientForShop(shop)`) and plain inputs, returning typed objects; operations validated against Admin API 2026-10; tests in `test/unit/shopify/` with `FakeGraphql` |

## Config and infrastructure

| Rails | ShopCare v2 | Status | Notes |
|---|---|---|---|
| `shopify.app.toml` | `shopify.app.toml` | done | scopes, app proxy (`apps`/`repairs` → `/proxy`), compliance webhooks. client_id is blank until linked |
| `config/initializers/shopify_app.rb` (runtime webhooks) | `[[webhooks.subscriptions]]` in `shopify.app.toml` | done | app/uninstalled, orders/paid, refunds/create, 3 compliance topics; API version 2025-10 → 2026-10 |
| `config/initializers/shopify_app.rb` (`after_authenticate_job`) | `hooks.afterAuth` in `app/shopify.server.ts` → `setUpShopAfterAuth` (app/services/shops/after-auth.server.ts) | done | creates/reactivates the Shop row, ensures the customer signing key (encrypted column + app-data metafield) and queues the order backfill once per shop (`queueOrderImport` → `import-orders` job) |
| `config/routes.rb` | `app/routes/*` (flat routes) | done | proxy paths unchanged: `/proxy/intake`, `/proxy/status`, `/proxy/quotes/:token` (+ `/decline`), new in v2 `/proxy/tickets/:id/postage-slip`, `/proxy/orders`, `/proxy/catalog_search`, `/proxy/order_lookup`, `/proxy/care_plans`, `/proxy/care_offers`, `/proxy/trade_in_options`, `/proxy/trade_ins`; admin under `/app/*`; webhooks under `/webhooks/*` |
| `db/schema.rb` + `db/migrate/*` (26) | `prisma/schema.prisma` + `prisma/migrations/` | done | every domain table in one migration (`…_domain_schema`) on top of the template's `Session` migration; see [Schema notes](#schema-notes) |
| `config/recurring.yml` `expire_quotes` (daily 3am) | `netlify/functions/daily-expire-quotes.mts` → job `expire-quotes` | done | 03:00 UTC; replaced the `daily-example.mts` template |
| `config/storage.yml` (Disk / S3) | `app/lib/storage.server.ts` | done | Netlify Blobs; signed URLs served by `app/routes/files.$.tsx` |
| `Shop` `encrypts` | `app/lib/encryption.server.ts` | done | key rotation via `APP_ENCRYPTION_PREVIOUS_KEYS`; `*_ciphertext` columns, read/written with `shopSecret` / `setShopSecret` in `app/models/shop.server.ts` |
| `config/initializers/content_security_policy.rb` | `addDocumentResponseHeaders` (library) | done | the library sets frame-ancestors |
| `test/storefront` CI job | `.github/workflows/ci.yml` | done | the Liquid+jsdom journeys are the Vitest `storefront` project (test/storefront/), so `npm test` in the main CI job runs them; the request/response contract is test/integration/routes/extension-contract.test.ts |
| `bin/brakeman`, `bin/rubocop` | `npm run lint`, `npm run typecheck` | done | |
| Solid Queue / Solid Cache / Puma / Docker | Netlify Functions | done | `Dockerfile` kept from the template for self-hosting only |
| `Rails.cache` (product facts, catalogue, repair products) | `cache_entries` table, `PostgresCache` (app/lib/postgres-cache.server.ts) | done | default `ShopifyCache` outside Vitest (in-memory under Vitest); TTL per caller; DB errors = cache miss |
| `ProxyThrottling` (Rails.cache counters) | `proxy_throttles` table, `postgresThrottleStore` | done | default outside Vitest |
| — (v2) daily housekeeping | `netlify/functions/daily-prune.mts` → job `daily-prune` | done | 03:15 UTC: throttle rows older than a day, expired cache entries |
| — (v2) stuck-notification sweep | `netlify/functions/hourly-notification-sweep.mts` → job `notification-sweep` | done | hourly at :20: re-enqueues `pending` deliveries 15 min–48 h old |
| — (v2) email unsubscribe + suppression | removed 16-10-2026 (Shopify sends every email; see [Notifications](#notifications)) | removed | migration `…_shopify_sends_emails` drops `email_suppressions` |
| — (v2) "Add Care" offer timing | `netlify/functions/daily-care-offers.mts` → job `care-offers` | done | 10:00 UTC: emits `care_offer` (Flow / Klaviyo) `care_offer_delay_days` (default 7) after purchase and syncs the `shopcare-care-offer-eligible` customer tag |

## Service contract

Shared quote and ticket-state services, called by admin routes, the
storefront review page and jobs. All take the Shop row id, return
`{ ok: true, … } | { ok: false, error }`, hold the row's lock (Rails
`with_lock`) for the state change, and accept `client` / `db` / `now` /
`enqueue` / `notifyDeps` options for tests.

| Function | Module | Rails |
|---|---|---|
| `sendQuote({ shopId, quotationId, actor })` → `{ warranty }` | app/services/quotes/send.server.ts | Repairs::QuoteSender#call |
| `resendInvoice({ shopId, quotationId, actor })` | app/services/quotes/resend.server.ts | QuoteSender#resend |
| `reviseQuote({ shopId, quotationId, actor })` → `{ newQuotationId }` | app/services/quotes/revise.server.ts | QuotationsController#revise + Quotation#revise! |
| `declineQuote({ shopId, quotationId, reason, by })`, `expireQuote({ shopId, quotationId })` | app/services/quotes/decision.server.ts | Repairs::QuoteDecision |
| `cancelOpenQuotesForTicket({ shopId, ticketId, actor })` → `{ cancelled, note }` | app/services/quotes/cancel.server.ts | Repairs::QuoteCanceller |
| `changeTicketStatus({ shopId, ticketId, to, actor, note? })` → `{ changed, message }` | app/services/repairs/ticket-status.server.ts | TicketsController#update_status + RepairTicket after_update_commit |

Every service that moves a ticket's status calls
`notifyRepairStatusChanged` after commit (Rails' after_update_commit).
Transitions: as in Rails, any known status other than the current one.

## Netlify cost and latency: App Proxy traffic

The theme extension calls the App Proxy on storefront pages; `care_offer` hits
`/apps/repairs/care_plans` on **every PDP view**. Each uncached request is a
Netlify Function invocation, billed and with a cold-start risk.

- Cache public responses on Netlify's CDN with `ctx.json(body, { cache: {…} })`
  (`publicCacheHeaders()` in `app/lib/http.server.ts`): `Netlify-CDN-Cache-Control: public, durable, …`
  plus `Netlify-Vary: query=shop|<params>`. Shopify's signature params change
  on every request, so without `Netlify-Vary` nothing would ever hit the cache.
- Safe to cache: `care_plans` (per shop + product), `catalog_search` (per shop
  + query), `trade_in_options` (per shop). Never cache anything that reads
  `logged_in_customer_id` (`orders`, `status`, `care_offers`, `quotes`), and no
  POSTs. A cache hit skips the signature check, so cached bodies must be data
  that is public anyway.
- Tag responses `shop:<domain>` and purge with `purgeCache({ tags })` when a
  merchant edits plans/programs, so short TTLs aren't needed.
- Better still, move data that only changes when the merchant edits it into
  shop/product **metafields** read by Liquid, so no proxy call happens at all.
  Consider this for Care plan eligibility.
- Webhooks: ack and enqueue (one function + one background invocation each).

## App Proxy routes

Every storefront endpoint is a React Router resource route
`app/routes/proxy.<path>.tsx` built with `proxyRoute` from
`app/lib/app-proxy.server.ts` (example: `app/routes/proxy.ping.tsx`):

```ts
export const loader = proxyRoute(
  { throttle: { name: "catalog", perIp: 60, perShop: 1200, periodSeconds: 60 } },
  async (ctx) => ctx.json({ ok: true, results }, { cache: { maxAge: 300, varyOn: ["q"], tags: [`shop:${ctx.shop}`] } }),
);
export const action = proxyRoute({ throttle: { ... } }, async (ctx) => {
  const customerId = await ctx.currentCustomerId();
  return ctx.json({ ok: true }, { cache: "no-store" });
});
```

- **Signature**: `authenticate.public.appProxy` (sorted params, hex HMAC-SHA256,
  constant-time; also rejects timestamps more than 90 s off, which Rails
  didn't). A bad signature throws 400 (Rails: 403). A shop without an offline
  session gets 404 unless `allowUninstalled`.
- **Context**: `shop`, `session`, `admin`, `storefront`, `pathPrefix` (use it
  for links; never hardcode `/apps/repairs`), `params`, and
  `currentCustomerId()`: `logged_in_customer_id`, else a valid signed customer
  token (24 h TTL, 5 min skew). Never a bare `customer_id`.
- **Caching** is chosen per response: `"no-store"` for anything per customer,
  POSTs and errors; public options only for GETs identical for every visitor.
  `ctx.json` throws if a response that called `currentCustomerId()` (or a
  non-GET) asks to be cached. `varyOn` must list every query param the body
  depends on; `shop` is always included (`Netlify-Vary: query=shop|…`), so the
  rotating `signature`/`timestamp` don't split the cache.
  A cache hit never reaches the function, so it skips the signature check and
  the throttle. https://docs.netlify.com/build/caching/caching-overview/
- **Liquid pages**: `ctx.liquid(html, { layout })` (`application/liquid`,
  no-store); escape every value with `liquidText`.
- **Throttle** (`throttle` option): fixed window, per shop + IP and per shop.
  The IP is the first `X-Forwarded-For` entry (Shopify's documented shopper
  IP), then `x-nf-client-connection-ip`: on proxy traffic the Netlify
  connecting IP is Shopify's, shared by every shopper.
- **Wiring / tests**: defaults are production: `customerSigningKey` reads the
  Shop row's decrypted key (`customerSigningKeyFor`), `rememberPathPrefix`
  writes `settings.proxy_path_prefix` on change (`rememberProxyPathPrefix`),
  `throttleStore` is Postgres (`proxy_throttles`; in memory under Vitest).
  `configureAppProxy({...})` swaps any of them plus `authenticate` and `now`;
  it returns a restore function. Unit tests stub every DB-backed dep.
  Integration tests use `appProxyRequest()` from
  `test/support/shopify-requests.ts`.

## Admin screens

- **Routes**: `app/routes/app.<area>*.tsx`; logic in `app/services/admin/*`. Every
  loader/action starts with `requireAdmin(request)` (`authenticate.admin` → the
  Shop row) and reads records with `where: { id, shopId }`, so another shop's id
  is a 404. Workshop inventory and trade-in screens redirect to `/app/tickets`
  when their flag is off (Rails `require_parts` / `require_trade_in`).
- **Actions**: one action per page, chosen by a hidden `intent` field; input is
  checked with zod (`app/services/admin/form.server.ts`: malformed ids → 404,
  malformed values → 400) before model validation gives the merchant-facing
  messages. Forms keep Rails' hidden "0" + checkbox pattern (last value wins).
  An invalid save returns `data({ errors, values }, 422)` and the form
  re-renders with them.
- **Flash**: redirects carry `?notice=` / `?alert=`; `app/components/flash-toast.tsx`
  shows an App Bridge toast and strips them (no cookies inside the admin iframe).
- **Polaris web components** under React 18: kebab-case attributes, booleans
  via `checkedIf`/`selectedIf` spreads (app/components/attrs.ts), uncontrolled
  fields read from FormData; CSV downloads are fetched (App Bridge adds the
  session token) and saved as a blob.
- **Contract services**: the admin calls the shared services above and shows
  what they return (`changeTicketStatus` → `message`, `sendQuote` →
  `warranty`); trade-in steps call app/services/trade-ins/workflow.server.ts.
  Items → "Import recent orders" enqueues the `import-orders` job
  (`itemsDeps.enqueueImport`).
- **Tests**: `test/support/admin.ts` (`signInAs(shop, { admin })`, `get`, `post`,
  `flash`, `statusOf`, `dataOf`) runs loaders/actions against Postgres; the
  Shopify client is a `FakeGraphql`, contract services are `vi.mock`ed (their own tests, and test/integration/e2e/scenarios.test.ts, run them for real).

## Notifications

**Decision (16-10-2026): every customer and staff email is sent by Shopify.**
ShopCare has no email provider (Resend was removed with its templates,
consent check, unsubscribe link, suppression list and webhook). ShopCare
works fully with Shopify Flow **off** (the default); Flow and Klaviyo are
optional integrations for merchants who want extra emails of their own.

### Email → Shopify

| Email | How Shopify sends it | Data it relies on | Docs |
|---|---|---|---|
| Repair quote | Draft-order invoice: Send quote creates the draft order and calls `draftOrderInvoiceSend` (subject/message from Settings → Emails → Quote email) | the draft order | [draftOrderInvoiceSend](https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderInvoiceSend) |
| "Send your item to us" + postage slip | **Order confirmation**, via the ShopCare snippet the merchant pastes into Settings → Notifications → Order confirmation (`app/services/emails/order-confirmation.liquid`; Settings → Emails has a copy button and previews, setup step 4 offers it). Shown only on repair orders: workshop address, posting instructions, "Download your postage slip", repair number, status page link | the repair draft order's **custom attributes**, which become the order's `attributes`: `repair_ticket_id`, `shopcare_postage_slip_url` (signed, valid for the quote's validity + 30 days), `shopcare_workshop_address`, `shopcare_posting_instructions`, `shopcare_status_url`, `shopcare_item_received`. Written at Send quote (and refreshed on resend/revise), so they're there when the order is created | [notification variables](https://help.shopify.com/en/manual/fulfillment/setup/notifications/email-variables) (`attributes`, `line_items`, `line.properties`, `created_at`, `metafields`); [DraftOrderInput.customAttributes](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/DraftOrderInput) |
| Care plan confirmation | The same snippet's Care section on any order with a Care line: "Your ShopCare 2 year plan covers all repairs to your <product> until <date>, except the exclusions in the plan's terms" + the statutory rights sentence | Care cart line properties set by the theme: `_shopcare_for` / `_shopcare_item`, `_shopcare_term_months`, `_shopcare_cover_ends` (Add Care later), `Product` | same |
| Repaired item posted back | **Shipping confirmation**: ticket → **Mark returned** fulfils the repair order (`fulfillmentCreate`, tracking, `notifyCustomer: true`) and completes the ticket | the paid quote's `shopify_order_id` | [fulfillmentCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate), [FulfillmentInput.notifyCustomer](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/FulfillmentInput) |
| Staff: repair paid | Shopify's own staff **New order** notification ("Sent when a customer places an order"; repair orders are ordinary orders, tagged `shopcare-repair`). The page doesn't say whether a draft order completed by an app (£0) triggers it: the Needs attention list and the optional **Repair quote paid** Flow trigger cover that | — | [Staff notifications](https://help.shopify.com/en/manual/fulfillment/setup/notifications/staff-notifications) |
| Staff: new request, quote declined / expired, item late, item received | The admin's **Needs attention** list on the Tickets home (no email). Optional: Flow triggers **Repair request submitted**, **Repair quote paid / declined / expired** → Flow's "Send internal email" | — | [Send internal email](https://help.shopify.com/en/manual/shopify-flow/reference/actions/send-email) |
| "Add Care to your purchase" (marketing) | Not sent by ShopCare. Without Flow: a Shopify Email campaign to customers tagged **`shopcare-care-offer-eligible`** (kept in step daily). With Flow: the **Add Care offer** trigger → Shopify Messaging's "Send marketing email" (sends only to customers subscribed to email marketing) | tag sync: `tagsAdd` / `tagsRemove` on Customer (`write_customers`, already granted) | [Flow app connectors](https://help.shopify.com/en/manual/shopify-flow/reference/connectors/apps), [tagsAdd](https://shopify.dev/docs/api/admin-graphql/latest/mutations/tagsAdd) |
| Request received, item received, in repair / status changes, Care credit code | **Not emailed.** The repair form's confirmation shows the tracker (Requested → Quoted → Awaiting item → Received → In repair → Returned); the Repair status block shows each repair's step, the postage slip download and the customer's Care credit codes; the admin item page shows staff the code to share. Flow triggers (repair status changed, Care activated, Care credit issued) stay for merchants who want to email these themselves | — | — |
| GDPR data request (to the merchant) | **Not emailed.** The export is listed in Settings → Customer data requests (signed download) with a banner on the Tickets home; optional Flow trigger **Customer data request** → "Send internal email" | — | — |

### £0 (covered) repairs and the order confirmation

A £0 quote is completed straight away with `draftOrderComplete` (marked as
paid, no invoice). Shopify's Help Center says marking a draft order as paid
sends the customer an order confirmation ("The received amount isn't captured
again by your payment provider, and the customer receives an order
confirmation email",
[Accepting payment for draft orders](https://help.shopify.com/en/manual/fulfillment/managing-orders/create-orders/get-paid)),
and the API reference says the customer "can be notified" when a draft order
is completed
([draftOrderComplete](https://shopify.dev/docs/api/admin-graphql/latest/mutations/draftOrderComplete));
the mutation has no notify flag. So a £0 repair's customer gets the Order
confirmation with the ShopCare section, as long as the draft order has their
email (it always does: `email` is the ticket's). **Verify on the dev store**
(GOING-LIVE): if a store's £0 completions don't send it, staff can resend it
from the order page in Shopify, and the Repair status block links the slip
either way.

### Optional integrations

Flow triggers (`extensions/shopcare-flow-*`, Settings → Emails → "Send
ShopCare events to Shopify Flow", **off by default**): care-activated,
care-credit, care-offer, quote-paid, quote-declined, quote-expired,
repair-status, and (v2) **repair-submitted** and **data-request** (staff
alerts, no customer reference); plus `parked/shopcare-flow-trade-in-status`.
Klaviyo metrics: the same events except the data request (its export link
must not land on the customer's profile). Ready-made recipes are in
[GOING-LIVE](GOING-LIVE.md#flow-recipes-optional). Flow **template
extensions** (`type = "flow_template"`) need a workflow exported from the
Flow app as a `.flow` file, which "shouldn't be edited directly"
([Create a Flow template](https://shopify.dev/docs/apps/build/flow/templates/create-a-template));
none is shipped until those are exported from a dev store.

### Reliability

- Never sends inline from a request or webhook: `notify` / `emitNotification`
  claim a `notification_deliveries` row per channel (`flow`, `klaviyo`)
  under the idempotency key `<event>:<record id>` (unique on
  `(shop_id, channel, idempotency_key)`), then enqueue the `notification`
  job. Retryable failures (throttling, 5xx, network) are rethrown so the
  background function retries; `attempts` and `error` are recorded.
- An hourly sweep (`netlify/functions/hourly-notification-sweep.mts`)
  re-enqueues deliveries stuck in `pending`.
- `notification_deliveries` is the log merchants see in Settings → Recent
  notifications.

### "Add Care to your purchase" timing

The daily `care-offers` job (`netlify/functions/daily-care-offers.mts`,
10:00 UTC) emits `care_offer` `care_offer_delay_days` (default 7) after
purchase, one per order (`care_offer:order_<id>`, 2-day catch-up), and keeps
the `shopcare-care-offer-eligible` customer tag on exactly the customers who
can still add Care (bought ≥ delay days ago, plan still on offer, no Care;
guests can't be tagged). Buying Care removes the tag at once (orders/paid).
Code: app/services/care/care-offers.server.ts,
app/services/care/care-offer-tags.server.ts, app/jobs/care-offers.server.ts.

## Schema notes

- `…_proxy_throttles_and_cache` (integration-1) adds two v2 infrastructure
  tables with no Rails counterpart: `proxy_throttles` (App Proxy counters,
  from the reviewed `prisma/pending/proxy_throttles.sql`, now removed) and
  `cache_entries` (shared TTL cache: `key` PK, `value` jsonb, `expires_at`).
  Both are pruned by the daily `daily-prune` job.
- `…_w2backend_email_suppressions` added `email_suppressions` (ShopCare's
  own email suppression list); `…_shopify_sends_emails` (16-10-2026) drops
  it again with `notification_deliveries.provider_message_id` and
  `repair_tickets.postage_emails_sent`, and deletes old `email` /
  `staff_email` deliveries: Shopify sends every email. Channels are `flow`
  and `klaviyo`.

Phase 2 (branch `schema`) ported every domain table from `db/schema.rb` and
the model layer.

- **Names:** tables and columns keep the Rails snake_case names via
  `@@map`/`@map`; Prisma fields are camelCase. Index names are the Rails ones.
  JSON contents (settings, terms, perks, grades…) keep their Rails keys.
- **Types:** `bigint` ids → `Int` autoincrement (int4; plenty for one shop's
  data, and it avoids JS `BigInt` everywhere). `decimal(p,s)` →
  `Decimal @db.Decimal(p,s)`. `jsonb` → `Json @db.JsonB` with the same
  defaults. `datetime` → `timestamp(3)` (JS dates have millisecond
  precision). `string` → `text`. Rails enums stay string columns; the values
  are `as const` arrays + TS unions in each `app/models/*` module.
- **Hand-written SQL** in the migration (Prisma can't express it, and its
  diff ignores it, so `migrate dev` stays clean): partial unique indexes
  `index_covers_on_care_line_unit`,
  `index_items_on_shop_id_and_order_line_id_and_unit_index`,
  `index_trade_ins_one_open_per_item`; the expression index
  `index_product_groups_on_shop_id_and_name` on `(shop_id, lower(name))`;
  and `DEFERRABLE INITIALLY DEFERRED` on the four restrict foreign keys.
- **Deletes:** Rails `dependent:` maps to `onDelete`: destroy/delete_all →
  Cascade, nullify → SetNull, restrict_with_error → NoAction made deferrable
  (checked at commit, so a shop delete cascades whatever order Postgres runs
  the cascades in; the model layer still refuses such deletes up front, e.g.
  `deleteProductGroup`).
- **Shop:** keyed by `shopify_domain`; no `shopify_token` / `access_scopes`
  (the template's `Session` table holds tokens and scopes). Encrypted
  `klaviyo_api_key_ciphertext`, `customer_signing_key_ciphertext` and
  `webhook_secret_ciphertext` (was plaintext `settings["webhook_secret"]`
  in Rails), each bound to its column with context `"Shop.<field>"`.
- **Quotation token:** `decision_token_digest` (SHA-256 hex, as Rails, for
  lookup) + `decision_token_ciphertext` (to rebuild the review link and to
  compare in constant time).
- **Active Storage:** `ticket_images` gets `storage_key`, `filename`,
  `content_type`, `byte_size`; `registrations` gets `proof_*` columns;
  `trade_ins.photos` is a jsonb list of `{ key, filename, contentType,
  byteSize }`. No `active_storage_*` tables.
- **notification_deliveries** gains v2 columns: `idempotency_key`,
  `attempts` and a unique index on `(shop_id, channel, idempotency_key)`.
  Rails' `error` column keeps the last error.
- **Model layer:** `app/models/<name>.server.ts`, plain functions over Prisma
  rows. `create*`/`update*` normalise, validate (`Errors` /
  `ValidationError` in `validation.server.ts`, Rails messages) and save;
  pure `validate*` functions need no database. `with_lock` →
  `withRowLock(tx, table, id)` (`SELECT … FOR UPDATE`) inside
  `inTransaction` (`app/lib/db-lock.server.ts`). Rails search scopes →
  `*SearchWhere(term)` (ILIKE with wildcards escaped). There are no
  callbacks: RepairTicket's `after_update_commit` notification becomes
  `repairStatusChangedEvent(ticket)` for the caller to dispatch.
- **Data migration from Rails** (not done): Active Record encrypted values
  must be decrypted in Rails and re-encrypted with the v2 key; ids can be
  copied as they are.

## File-by-file checklist (generated from `git ls-tree rails-reference`)

### Models (28)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/models/application_record.rb` | app/db.server.ts (Prisma client) | done | Prisma client; shared helpers in app/models/validation.server.ts |
| `app/models/care_credit.rb` | prisma/schema.prisma `CareCredit` + app/models/care-credit.server.ts | done | |
| `app/models/care_plan.rb` | prisma/schema.prisma `CarePlan` + app/models/care-plan.server.ts | done | |
| `app/models/concerns/product_eligibility.rb` | app/models/product-eligibility.server.ts | done | |
| `app/models/concerns/product_grouped.rb` | app/models/product-grouped.server.ts | done | |
| `app/models/cover.rb` | prisma/schema.prisma `Cover` + app/models/cover.server.ts | done | `record_claim!` uses withRowLock |
| `app/models/item.rb` | prisma/schema.prisma `Item` + app/models/item.server.ts | done | cover helpers take the item with its covers loaded (`findItemWithCovers`) |
| `app/models/notification_delivery.rb` | prisma/schema.prisma `NotificationDelivery` + app/models/notification-delivery.server.ts | done | keeps its role as the per-event delivery log + idempotency record (channels `flow`, `klaviyo`); `NotificationStore` interface + in-memory store in app/services/notifications/store.server.ts; Prisma implementation `PrismaNotificationStore` |
| `app/models/part.rb` | prisma/schema.prisma `Part` + app/models/part.server.ts | done | default variant created in the same transaction (was `after_save`) |
| `app/models/part_import.rb` | prisma/schema.prisma `PartImport` + app/models/part-import.server.ts | done | `importer` moves to app/services/parts/csv-import |
| `app/models/part_variant.rb` | prisma/schema.prisma `PartVariant` + app/models/part-variant.server.ts | done | `move_stock!` uses withRowLock |
| `app/models/processed_refund.rb` | prisma/schema.prisma `ProcessedRefund` + app/models/processed-refund.server.ts | done | |
| `app/models/product_group.rb` | prisma/schema.prisma `ProductGroup` + app/models/product-group.server.ts | done | |
| `app/models/quotation.rb` | prisma/schema.prisma `Quotation` + app/models/quotation.server.ts | done | `encrypts :decision_token` → `decision_token_digest` (SHA-256, as Rails, for lookup) + `decision_token_ciphertext` (GCM, for the link and a constant-time compare); `revise!` uses withRowLock |
| `app/models/quotation_line_item.rb` | prisma/schema.prisma `QuotationLineItem` + app/models/quotation-line-item.server.ts | done | |
| `app/models/registration.rb` | prisma/schema.prisma `Registration` + app/models/registration.server.ts | done | `has_one_attached :proof` → `proof_key` + `proof_*` metadata columns |
| `app/models/repair_service.rb` | prisma/schema.prisma `RepairService` + app/models/repair-service.server.ts | done | |
| `app/models/repair_ticket.rb` | prisma/schema.prisma `RepairTicket` + app/models/repair-ticket.server.ts | done | status-change notification: `repairStatusChangedEvent`, dispatched by callers (no callbacks) |
| `app/models/service_component.rb` | prisma/schema.prisma `ServiceComponent` + app/models/service-component.server.ts | done | |
| `app/models/shop.rb` | prisma/schema.prisma `Shop` + app/models/shop.server.ts | done | `encrypts` klaviyo_api_key + customer_signing_key, and the webhook secret (was in settings) → `*_ciphertext` columns, context "Shop.<field>"; no token columns (Session has them) |
| `app/models/statutory_rights.rb` | app/models/statutory-rights.server.ts | done | a module, not a table |
| `app/models/stock_movement.rb` | prisma/schema.prisma `StockMovement` + app/models/stock-movement.server.ts | done | |
| `app/models/ticket_activity.rb` | prisma/schema.prisma `TicketActivity` + app/models/ticket-activity.server.ts | done | |
| `app/models/ticket_image.rb` | prisma/schema.prisma `TicketImage` + app/models/ticket-image.server.ts | done | ActiveStorage `has_one_attached :file` → `storage_key` + metadata columns (`storage.server.ts`) |
| `app/models/ticket_part.rb` | prisma/schema.prisma `TicketPart` + app/models/ticket-part.server.ts | done | |
| `app/models/trade_in.rb` | prisma/schema.prisma `TradeIn` + app/models/trade-in.server.ts | done | `has_many_attached :photos` → `photos` jsonb list of storage keys + metadata |
| `app/models/trade_in_program.rb` | prisma/schema.prisma `TradeInProgram` + app/models/trade-in-program.server.ts | done | |
| `app/models/warranty_policy.rb` | prisma/schema.prisma `WarrantyPolicy` + app/models/warranty-policy.server.ts | done | |

### Services (53)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/services/care/activator.rb` | app/services/care/activator.server.ts | done | `CareActivator`; units locked with `SELECT … FOR UPDATE` on the order's items; unique (shop, line, unit) makes races safe |
| `app/services/care/credit_issuer.rb` | app/services/care/credit-issuer.server.ts | done | `issueCareCredit`; one credit per cover |
| `app/services/care/notices.rb` | app/services/care/notices.server.ts | done | `notifyCareActivated` (orders/paid); the `care_offer` half moved to the daily care-offers job |
| `app/services/care/plan_economics.rb` | app/services/care/plan-economics.server.ts | done | `planEconomicsSummary`; claims cost from completed tickets' `costs` (parts + labour) less excess collected |
| `app/services/care/plan_refunder.rb` | app/services/care/plan-refunder.server.ts | done | `refundCarePlan(client, cover)` → `refundLineItem` (app/shopify/refunds.server.ts); v2 fix: refunds in the presentment currency (`presentmentMoney` + `RefundInput.currency`) when the order currency differs from the shop's |
| `app/services/care/plan_terms.rb` | app/services/care/plan-terms.server.ts | done | pure function; tests are in care-plan.test.ts (Rails tested it via care_plan_test) |
| `app/services/care/refund_handler.rb` | app/services/care/refund-handler.server.ts | done | `handleCareRefund`; Shopify client and shop currency resolved lazily |
| `app/services/items/order_data.rb` | app/shopify/orders.server.ts | done | `orderFromGraphql` / `orderFromWebhook` → `OrderData`; unit price is a decimal string |
| `app/services/items/order_importer.rb` | app/services/items/order-importer.server.ts | done | `OrderImporter.importOrder` / `importRecent` over `fetchCustomerOrder` / `fetchRecentPaidOrders`; the backfill is the `import-orders` job (cursor-paged, re-enqueues itself) |
| `app/services/items/owned_item_resolver.rb` | app/services/storefront/owned-item-resolver.server.ts | done | storefront-only caller; imports an old order on demand via `OrderImporter` |
| `app/services/items/recorder.rb` | app/services/items/recorder.server.ts | done | `ItemRecorder`; product facts fetched before the transaction; unique (shop, line, unit) makes concurrent webhooks safe |
| `app/services/items/refund_processor.rb` | app/services/items/refund-processor.server.ts | done | `processRefund`; processed_refunds claim via `INSERT … ON CONFLICT DO NOTHING` in the same transaction; line ids from GIDs when present |
| `app/services/items/registration_submission.rb` | app/services/items/registration-submission.server.ts | deferred | deferred: no caller in the Rails app (no storefront registration route at `rails-reference`); port with the storefront registration flow |
| `app/services/notifications/delivery_error.rb` | app/services/notifications/delivery-error.server.ts | done | adds `retryable` |
| `app/services/notifications/dispatcher.rb` | app/services/notifications.server.ts (`emitNotification`, `deliverNotification`) + notifications/events.server.ts (EVENTS) | done | v2: Flow + Klaviyo only (Shopify sends every email; see Notifications). Production deps (notifications/production-deps.server.ts) are the default outside tests: `PrismaNotificationStore`, `loadNotificationSettings` (Shop row), the Admin client |
| `app/services/notifications/flow_client.rb` | app/shopify/flow.server.ts (`triggerFlow`, `flowPayload`) + app/services/notifications/flow-client.server.ts (`FlowClient`: one attempt, errors → `DeliveryError`) | done | optional integration, unchanged trigger set; **off by default**. `customer_id` is the only place an id becomes a JSON number (Flow requires it); ids past 2^53 are sent as digits |
| `app/services/notifications/klaviyo_client.rb` | app/services/notifications/klaviyo-client.server.ts | done | optional integration, unchanged event set; only 429/5xx/network retried |
| `app/services/parts/consumer.rb` | app/services/parts/consumer.server.ts | done | `consumeTicketParts` (run by changeTicketStatus on completion; plans first if the ticket has no parts); each part re-checked under its row lock, so a second completion takes nothing twice |
| `app/services/parts/csv_export.rb` | app/services/parts/csv-export.server.ts | done | `exportParts`, `exportStockUsed`; CSV via app/lib/csv.ts |
| `app/services/parts/csv_import.rb` | app/services/parts/csv-import.server.ts | done | `CsvImport.build(...)` → `errors`/`summary()`/`apply()`; CSV stored in part_imports.csv_data (no background job: 2 MB / 5000 rows applies in one transaction) |
| `app/services/parts/item_properties.rb` | app/services/parts/item-properties.server.ts | done | `itemProperties(shop, client, item)`: fetched once (`fetched_at`), saved on the Item; Shopify read is `fetchVariantProperties` |
| `app/services/parts/matcher.rb` | app/services/parts/matcher.server.ts | done | `matchComponent` (candidates in id order) |
| `app/services/parts/planner.rb` | app/services/parts/planner.server.ts | done | `planTicketParts({ shopId, ticketId })` (shop-scoped; used by admin "Plan parts" and the consumer) |
| `app/services/parts/reorder_list.rb` | app/services/parts/reorder-list.server.ts | done |  |
| `app/services/parts/service_sync.rb` | app/services/repairs/service-import.server.ts | done | `importRepairServices(shopId, catalog)` |
| `app/services/parts/ticket_costs.rb` | app/services/parts/ticket-costs.server.ts | done | `ticketCosts` |
| `app/services/repairs/catalog_search.rb` | app/shopify/catalog-search.server.ts | done | `searchCatalog`; the caller passes repair-service + Care plan variant ids as `excludedVariantIds` |
| `app/services/repairs/customer_redactor.rb` | app/services/gdpr/customer-redactor.server.ts (+ customer-match.server.ts) | done | v2 also redacts photos (files), free-text activity bodies, decline reasons, item properties, registration proofs/notes, trade-in staff notes + photos, notification payloads; matches `orders_to_redact` too |
| `app/services/repairs/event_payload.rb` | app/services/repairs/event-payload.server.ts | done | takes plain ticket/quotation objects |
| `app/services/repairs/intake_submission.rb` | app/services/repairs/intake-submission.server.ts | done | `submitIntake`; photos → storage (type from the file's first bytes: JPEG/PNG/WebP/HEIC only, size from TicketImage, `settings.intake.max_images`, best effort); emits outbound webhook `submitted` + `repair_submitted` notification; validation errors keep Rails' "Validation failed: …" text |
| `app/services/repairs/order_lookup.rb` | app/services/repairs/order-lookup.server.ts | done | `lookUpOrder` (records Items, one per line, images) + `orderToken` / `verifiedOrderId` (HMAC-signed, 2 h, per shop; key derived from APP_ENCRYPTION_KEY) |
| `app/services/repairs/payment_processor.rb` | app/services/payments/repair-payment.server.ts | done | `processRepairPayment` |
| `app/services/repairs/product_cards.rb` | app/services/storefront/product-cards.server.ts | done | `ProductCards.load` + `coverJson` |
| `app/services/repairs/product_catalog.rb` | app/shopify/repair-products.server.ts | done | `listRepairVariants` (cached), `fetchRepairVariants` (paged, errors propagate: for ServiceSync), `fetchRepairVariant`; settings passed in |
| `app/services/repairs/purchase_history.rb` | app/shopify/orders.server.ts | done | `fetchPurchaseHistory` |
| `app/services/repairs/quote_canceller.rb` | app/services/quotes/cancel.server.ts | done | contract `cancelOpenQuotesForTicket({ shopId, ticketId, actor })` |
| `app/services/repairs/quote_decision.rb` | app/services/quotes/decision.server.ts | done | contract `declineQuote` / `expireQuote` |
| `app/services/repairs/quote_draft_order.rb` | app/services/repairs/quote-draft-order.server.ts | done | attributes + `ensureQuoteDraftOrder` (`id!`) + `deleteQuoteDraftOrder`; repair variants carry `priceOverride` |
| `app/services/repairs/quote_notifications.rb` | app/services/quotes/notifications.server.ts | done | `notifyQuotePaid/Declined/Expired` (Flow staff-alert triggers, with the admin ticket link) |
| `app/services/repairs/quote_sender.rb` | app/services/quotes/send.server.ts, resend.server.ts | done | contract `sendQuote`, `resendInvoice`; row lock held for the send in a 90 s transaction; `reviseQuote` (QuotationsController#revise) in quotes/revise.server.ts |
| `app/services/repairs/webhook_delivery.rb` | app/services/repairs/webhook-delivery.server.ts | done | SSRF guard: strict outside development/test, every resolved address public (wider ranges than Rails), connection pinned, no redirects. Headers: `User-Agent: ShopCare-Webhook/1.0`, `X-ShopCare-Event`, `X-ShopCare-Hmac-Sha256` |
| `app/services/shopify/admin_api.rb` | app/shopify/graphql.server.ts, client.server.ts, draft-orders.server.ts, customers.server.ts, shop.server.ts | done | `adminGraphql` (typed data, THROTTLED/429 retry with backoff, `ShopifyGraphqlError`/`ShopifyUserError`), `adminClientForShop` (offline session). REST draft orders → `draftOrderCreate/Update/InvoiceSend/Complete/Delete`; REST customer metafields → `customer.metafield` + `metafieldsSet`; `shop_name` → `fetchShopInfo` |
| `app/services/shopify/customer_signing_key.rb` | app/shopify/customer-signing-key.server.ts | done | storage via a `save` callback: `saveCustomerSigningKey(shopId)` in app/models/shop.server.ts (encrypted column + `customer_signing_key_published_at` in settings); called from afterAuth |
| `app/services/shopify/customer_token.rb` | app/lib/customer-token.server.ts | done | the single copy (exact `secure_compare` semantics); takes the decrypted key; the App Proxy looks it up on the Shop row (`customerSigningKeyFor`) |
| `app/services/shopify/discount_codes.rb` | app/shopify/discount-codes.server.ts | done |  |
| `app/services/shopify/gid.rb` | app/lib/gid.ts | done | `numericId` / `buildGid` / `numericIdOrNull`; ids are strings |
| `app/services/trade_ins/credit_issuer.rb` | app/services/trade-ins/credit-issuer.server.ts | done | `issueTradeInCredit` → `{ method, reference }`; currency = trade-in's, else the shop's (passed in; Rails fell back to GBP) |
| `app/services/trade_ins/order_linker.rb` | app/services/trade-ins/order-linker.server.ts | done | `linkTradeInsToOrder`; status notice `notifyTradeInStatus` (notify-status.server.ts) for the workflow to reuse |
| `app/services/trade_ins/quoter.rb` | app/services/trade-ins/quoter.server.ts | done | `TradeInQuoter#forItem` / `forUnknown`; Shopify (product facts, today's price) injected; used by the staff workflow |
| `app/services/trade_ins/submission.rb` | app/services/trade-ins/submission.server.ts | deferred | deferred (decided): storefront trade-in is parked for V2; the proxy endpoints answer "not available" even with the flag on |
| `app/services/trade_ins/workflow.rb` | app/services/trade-ins/workflow.server.ts | done | `approveTradeIn` / `rejectTradeIn` / `cancelTradeIn` / `receiveTradeIn` / `creditTradeIn`; crediting claimed under the row lock (credit issued once), failure → back to received; the item is traded in and its cover ends |
| `app/services/warranty/cover_assigner.rb` | app/services/warranty/cover-assigner.server.ts | done | `CoverAssigner.factsFor` (outside the transaction) + `assign` |
| `app/services/warranty/product_facts.rb` | app/shopify/product-facts.server.ts (`ProductFactsLoader`) + app/models/product-facts.ts (`ProductFacts` type) | done | per-instance memo + `ShopifyCache` (Postgres-shared outside tests) |

### Controllers: proxy (storefront) (9)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/controllers/proxy/base_controller.rb` | app/lib/app-proxy.server.ts + app/services/storefront/deps.server.ts | done | `proxyRoute`; `storefrontRoute` adds Rails `set_shop` (404 without a Shop row) and swappable deps (`configureStorefront`) |
| `app/controllers/proxy/care_controller.rb` | app/routes/proxy.care_plans.tsx, proxy.care_offers.tsx | done | care_plans public, CDN-cached (Netlify-Vary: shop\|product_id\|product_title, 300 s); care_offers no-store |
| `app/controllers/proxy/catalog_controller.rb` | app/routes/proxy.catalog_search.tsx | done | throttled (60/IP, 1200/shop per minute); public, CDN-cached on `q` (300 s) |
| `app/controllers/proxy/intake_controller.rb` | app/routes/proxy.intake.tsx | done | multipart; `images[]` (or `images`) → storage; v2 throttle: 10/h per visitor, 300/h per shop (429 JSON `{ ok: false, error }`) |
| `app/controllers/proxy/order_lookups_controller.rb` | app/routes/proxy.order_lookup.tsx | done | throttled (10/IP, 300/shop per 10 min); generic 404; guests get the 2 h signed `order_token` |
| `app/controllers/proxy/orders_controller.rb` | app/routes/proxy.orders.tsx | done | no-store |
| `app/controllers/proxy/quotes_controller.rb` | app/routes/proxy.quotes.$token.tsx, proxy.quotes.$token_.decline.tsx (app/services/storefront/quote-routes.server.ts) | done | Liquid in the theme layout; Cache-Control is `private, no-store` (Rails: `no-store`); decline/expire call the contract's `declineQuote`/`expireQuote` |
| `app/controllers/proxy/status_controller.rb` | app/routes/proxy.status.tsx | done | no-store |
| `app/controllers/proxy/trade_ins_controller.rb` | app/routes/proxy.trade_in_options.tsx, proxy.trade_ins.tsx | deferred | flag check ported (404 `{ok:false, available:false, errors}`); flag-on path deferred with Submission (trade-in parked for V2), so it stays "not available" |

### Controllers: admin (embedded) (22)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/controllers/admin_controller.rb` | app/routes/app.tsx + app/services/admin/context.server.ts | done | `requireAdmin` (authenticate.admin → Shop row), `requireParts`/`requireTradeIn`, shop-scoped `orNotFound`; layout nav in app.tsx |
| `app/controllers/application_controller.rb` | app/root.tsx / app/shopify.server.ts | done | template |
| `app/controllers/authenticated_controller.rb` | app/services/admin/context.server.ts | done | `requireAdmin` in every admin loader/action; tests swap it with `configureAdminAuth` (test/support/admin.ts) |
| `app/controllers/care_plans_controller.rb` | app/routes/app.care_plans._index/new/$id._index/$id.edit.tsx + app/services/admin/care-plans.server.ts | done | delete is an intent on the edit route |
| `app/controllers/concerns/proxy_throttling.rb` | app/lib/proxy-throttling.server.ts | done | Postgres upsert counter (`postgresThrottleStore`, `proxy_throttles`), pruned daily; v2 adds intake (10/h per visitor, 300/h per shop) |
| `app/controllers/items_controller.rb` | app/routes/app.items._index.tsx, app.items.$id.tsx + app/services/admin/items.server.ts | done | import enqueues the `import-orders` job (enqueuer injectable) |
| `app/controllers/part_imports_controller.rb` | app/routes/app.parts.imports.new/$id/template.tsx | done | apply claims the import (appliedAt) first, so a double-click can't apply twice |
| `app/controllers/part_variants_controller.rb` | app/routes/app.parts.$id._index.tsx (intents) | done |  |
| `app/controllers/parts_controller.rb` | app/routes/app.parts._index/new/$id._index/$id.edit/reorder/export/stock_used.tsx + app/services/admin/parts.server.ts | done | CSV downloads fetched with the session token (app/components/download-button.tsx) |
| `app/controllers/product_groups_controller.rb` | app/routes/app.product_groups._index/new/$id.tsx + app/services/admin/product-groups.server.ts | done |  |
| `app/controllers/quotation_line_items_controller.rb` | app/routes/app.tickets.$id.tsx (intents add_line/remove_line) + app/services/admin/tickets.server.ts | done |  |
| `app/controllers/quotations_controller.rb` | app/routes/app.tickets.$id.tsx (intents send/resend/revise/decline/cover) + app/services/admin/tickets.server.ts | done | send/resend/revise/decline call the shared contract (app/services/quotes/*); v2 adds "Decline on their behalf" |
| `app/controllers/registrations_controller.rb` | app/routes/app.items.$id.tsx (intents verify/reject) | done | reviewed from the item page, by the item's registration |
| `app/controllers/repair_services_controller.rb` | app/routes/app.repair_services._index.tsx, app.repair_services.$id.tsx | done |  |
| `app/controllers/service_components_controller.rb` | app/routes/app.repair_services.$id.tsx (intents add_component/remove_component) | done |  |
| `app/controllers/settings_controller.rb` | app/routes/app.settings.tsx + app/services/admin/settings.server.ts | done | v2: Emails section (Order confirmation snippet, quote email, Flow switch), Customer data requests; webhook secret is the encrypted column |
| `app/controllers/setup_controller.rb` | app/routes/app.setup.tsx + app/services/admin/setup.server.ts | done |  |
| `app/controllers/ticket_parts_controller.rb` | app/routes/app.tickets.$id.tsx (intents plan_parts/add_part/update_part/remove_part) | done |  |
| `app/controllers/tickets_controller.rb` | app/routes/app.tickets._index.tsx, app.tickets.$id.tsx + app/services/admin/tickets.server.ts | done | status changes call `changeTicketStatus` (shared contract) |
| `app/controllers/trade_in_programs_controller.rb` | app/routes/app.trade_in_programs._index/new/$id.tsx + app/services/admin/trade-in-programs.server.ts | done |  |
| `app/controllers/trade_ins_controller.rb` | app/routes/app.trade_ins._index.tsx, app.trade_ins.$id.tsx | done | steps call app/services/trade-ins/workflow.server.ts |
| `app/controllers/warranty_policies_controller.rb` | app/routes/app.warranty_policies._index/new/$id.tsx + app/services/admin/warranty.server.ts | done |  |

### Jobs (13)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/jobs/after_authenticate_job.rb` | app/services/shops/after-auth.server.ts | done | `setUpShopAfterAuth`: shop row, signing key, then `queueOrderImport` once (settings.items_import) |
| `app/jobs/app_uninstalled_job.rb` | app/routes/webhooks.app.uninstalled.tsx → `markShopUninstalled` | done | v2: sets `uninstalledAt` + deletes sessions; data erased by shop/redact (Rails destroyed the shop at once) |
| `app/jobs/application_job.rb` | app/jobs/registry.server.ts | done | → app/jobs/registry.server.ts (done: pattern) |
| `app/jobs/customers_data_request_job.rb` | app/jobs/webhook.server.ts CUSTOMERS_DATA_REQUEST → app/services/gdpr/customer-export.server.ts | done | v2: real JSON export in file storage, listed in Settings → Customer data requests (signed download) with a home banner and the optional "Customer data request" Flow trigger; deleted after 30 days by daily-prune (Rails only logged counts) |
| `app/jobs/customers_redact_job.rb` | app/jobs/webhook.server.ts CUSTOMERS_REDACT → `redactCustomer` | done |  |
| `app/jobs/expire_quotes_job.rb` | app/jobs/expire-quotes.server.ts | done | `expireOverdueQuotes` → `expireQuote` per quote; scheduled by netlify/functions/daily-expire-quotes.mts |
| `app/jobs/import_orders_job.rb` | app/jobs/import-orders.server.ts | done | 20 pages per run, cursor saved in settings.items_import and re-enqueued (`fetchPaidOrdersPage`) |
| `app/jobs/notification_job.rb` | app/jobs/notification.server.ts | done | one delivery per invocation; retryable errors rethrown until attempts = 3, then failed |
| `app/jobs/orders_paid_job.rb` | app/jobs/webhook.server.ts ORDERS_PAID | done | repair payment, else Items + cover + care_activated + trade-in linking |
| `app/jobs/outbound_webhook_job.rb` | app/jobs/outbound-webhook.server.ts | done | job `outbound-webhook`; `emitOutboundWebhook()`; default loader `loadOutboundWebhookContext` (app/services/repairs/outbound-webhook-context.server.ts); headers renamed `ShopCare-Webhook/1.0`, `X-ShopCare-Event`, `X-ShopCare-Hmac-Sha256` (Rails: `Repairs-App-*` / `X-Repairs-*`) |
| `app/jobs/refunds_create_job.rb` | app/jobs/webhook.server.ts REFUNDS_CREATE | done |  |
| `app/jobs/shop_redact_job.rb` | app/jobs/webhook.server.ts SHOP_REDACT → `redactShop` (app/services/gdpr/shop-redact.server.ts) | done | deletes stored files and GDPR exports, then the shop (cascade) and sessions |
| `app/jobs/shop_webhook_job.rb` | app/jobs/webhook.server.ts | done | topic table; unknown shop = no-op; `setWebhookJobDeps` for tests |

### Views (42)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/views/care_plans/_form.html.erb` | app/routes/app.care_plans* (component) | done |  |
| `app/views/care_plans/edit.html.erb` | app/routes/app.care_plans* (component) | done |  |
| `app/views/care_plans/index.html.erb` | app/routes/app.care_plans* (component) | done |  |
| `app/views/care_plans/new.html.erb` | app/routes/app.care_plans* (component) | done |  |
| `app/views/care_plans/show.html.erb` | app/routes/app.care_plans* (component) | done |  |
| `app/views/items/index.html.erb` | app/routes/app.items* (component) | done |  |
| `app/views/items/show.html.erb` | app/routes/app.items* (component) | done |  |
| `app/views/layouts/_flash_messages.html.erb` | app/root.tsx / app/routes/app.tsx | done | → Polaris toast via App Bridge (`shopify.toast.show`) |
| `app/views/layouts/application.html.erb` | app/root.tsx / app/routes/app.tsx | done | → app/root.tsx |
| `app/views/layouts/embedded_app.html.erb` | app/root.tsx / app/routes/app.tsx | done | → app/routes/app.tsx (AppProvider + s-app-nav) |
| `app/views/part_imports/new.html.erb` | app/routes/app.part_imports* (component) | done |  |
| `app/views/part_imports/show.html.erb` | app/routes/app.part_imports* (component) | done |  |
| `app/views/parts/_form.html.erb` | app/routes/app.parts* (component) | done |  |
| `app/views/parts/edit.html.erb` | app/routes/app.parts* (component) | done |  |
| `app/views/parts/index.html.erb` | app/routes/app.parts* (component) | done |  |
| `app/views/parts/new.html.erb` | app/routes/app.parts* (component) | done |  |
| `app/views/parts/reorder.html.erb` | app/routes/app.parts* (component) | done |  |
| `app/views/parts/show.html.erb` | app/routes/app.parts* (component) | done |  |
| `app/views/product_groups/_form.html.erb` | app/routes/app.product_groups* (component) | done |  |
| `app/views/product_groups/_select.html.erb` | app/routes/app.product_groups* (component) | done |  |
| `app/views/product_groups/edit.html.erb` | app/routes/app.product_groups* (component) | done |  |
| `app/views/product_groups/index.html.erb` | app/routes/app.product_groups* (component) | done |  |
| `app/views/product_groups/new.html.erb` | app/routes/app.product_groups* (component) | done |  |
| `app/views/proxy/quotes/show.html.erb` | app/services/storefront/quote-page.server.ts | done | `renderQuotePage`, every value through `liquidText` |
| `app/views/repair_services/_service.html.erb` | app/routes/app.repair_services* (component) | done |  |
| `app/views/repair_services/edit.html.erb` | app/routes/app.repair_services* (component) | done |  |
| `app/views/repair_services/index.html.erb` | app/routes/app.repair_services* (component) | done |  |
| `app/views/settings/show.html.erb` | app/routes/app.settings* (component) | done |  |
| `app/views/setup/_wizard.html.erb` | app/routes/app.setup* (component) | done |  |
| `app/views/tickets/_quote_decision.html.erb` | app/routes/app.tickets* (component) | done |  |
| `app/views/tickets/index.html.erb` | app/routes/app.tickets* (component) | done |  |
| `app/views/tickets/show.html.erb` | app/routes/app.tickets* (component) | done |  |
| `app/views/trade_in_programs/_form.html.erb` | app/routes/app.trade_in_programs* (component) | done |  |
| `app/views/trade_in_programs/edit.html.erb` | app/routes/app.trade_in_programs* (component) | done |  |
| `app/views/trade_in_programs/index.html.erb` | app/routes/app.trade_in_programs* (component) | done |  |
| `app/views/trade_in_programs/new.html.erb` | app/routes/app.trade_in_programs* (component) | done |  |
| `app/views/trade_ins/index.html.erb` | app/routes/app.trade_ins* (component) | done |  |
| `app/views/trade_ins/show.html.erb` | app/routes/app.trade_ins* (component) | done |  |
| `app/views/warranty_policies/_form.html.erb` | app/routes/app.warranty_policies* (component) | done |  |
| `app/views/warranty_policies/edit.html.erb` | app/routes/app.warranty_policies* (component) | done |  |
| `app/views/warranty_policies/index.html.erb` | app/routes/app.warranty_policies* (component) | done |  |
| `app/views/warranty_policies/new.html.erb` | app/routes/app.warranty_policies* (component) | done |  |

### Helpers (5)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/helpers/items_helper.rb` | app/lib/format.ts | done | |
| `app/helpers/liquid_helper.rb` | app/lib/http.server.ts (`liquidText`, `liquidResponse`) | done | |
| `app/helpers/parts_helper.rb` | app/lib/format.ts, app/lib/format.server.ts | done | |
| `app/helpers/tickets_helper.rb` | app/lib/format.ts, app/lib/format.server.ts (`formatMoney`) | done | |
| `app/helpers/trade_ins_helper.rb` | app/lib/format.ts | done | |

### Assets (1)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/assets/stylesheets/application.css` | (none) | done | dropped: the admin is Polaris web components with no custom stylesheet |

### JavaScript (1)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/javascript/application.js` | (none) | done | not needed (React); Enter-to-submit in app/components/submit-on-enter.tsx |

### Tests: models (12)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `test/models/care_plan_test.rb` | test/integration/models/care-plan.test.ts | done | same scenarios |
| `test/models/cover_test.rb` | test/integration/models/cover.test.ts | done | same scenarios |
| `test/models/part_test.rb` | test/integration/models/part.test.ts | done | `assert_raises(ArgumentError)` → `rejects.toThrow(ArgumentError)` (class exported by part.server.ts) |
| `test/models/product_group_test.rb` | test/integration/models/product-group.test.ts | done | same scenarios |
| `test/models/quotation_cover_test.rb` | test/integration/models/quotation-cover.test.ts | done | same scenarios |
| `test/models/quotation_line_item_test.rb` | test/integration/models/quotation-line-item.test.ts | done | same scenarios |
| `test/models/quotation_test.rb` | test/integration/models/quotation.test.ts | done | `token.succ` → last character changed |
| `test/models/repair_ticket_test.rb` | test/integration/models/repair-ticket.test.ts | done | same scenarios |
| `test/models/ticket_activity_test.rb` | (none) | done | empty in Rails (no tests); nothing to port |
| `test/models/ticket_image_test.rb` | (none) | done | empty in Rails (no tests); nothing to port |
| `test/models/trade_in_program_test.rb` | test/integration/models/trade-in-program.test.ts | done | same scenarios |
| `test/models/warranty_policy_test.rb` | test/integration/models/warranty-policy.test.ts | done | same scenarios |

### Tests: services (29)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `test/services/care/activator_test.rb` | test/integration/services/care/activator.test.ts | done | adds a concurrent-activation race |
| `test/services/care/notices_and_economics_test.rb` | test/integration/services/care/notices.test.ts + plan-economics.test.ts | done |  |
| `test/services/care/refund_handler_test.rb` | test/integration/services/care/refund-handler.test.ts | done |  |
| `test/services/items/order_data_test.rb` | test/unit/shopify/orders.test.ts | done |  |
| `test/services/items/order_importer_test.rb` | test/integration/services/items/order-importer.test.ts | done | Shopify half also in test/unit/shopify/orders.test.ts |
| `test/services/items/recorder_test.rb` | test/integration/services/items/recorder.test.ts | done | adds concurrent recording and the unit cap |
| `test/services/items/refund_processor_test.rb` | test/integration/services/items/refund-processor.test.ts | done | adds concurrent duplicate delivery and GID line ids |
| `test/services/items/registration_submission_test.rb` | test/integration/services/items/registration-submission.test.ts | deferred | deferred with RegistrationSubmission |
| `test/services/notifications/notifications_test.rb` | test/unit/notifications/{notifications,integrations}.test.ts + test/integration/wiring/notification-store.test.ts | done | unit: in-memory store; integration: Prisma store (claim/conflict/race), Shop-row settings, emit → deliver round trip |
| `test/services/parts/csv_import_test.rb` | test/integration/services/parts/csv-import.test.ts | done |  |
| `test/services/parts/item_properties_test.rb` | test/integration/services/parts/item-properties.test.ts | done | Shopify half also in test/unit/shopify/products.test.ts |
| `test/services/parts/planning_test.rb` | test/integration/services/parts/planning.test.ts + test/integration/services/repairs/ticket-status.test.ts | done | Matcher + Planner in planning.test.ts; Consumer + TicketCosts through changeTicketStatus (completion) |
| `test/services/parts/reorder_and_sync_test.rb` | test/integration/services/parts/reorder-and-sync.test.ts | done |  |
| `test/services/repairs/customer_redactor_test.rb` | test/integration/webhooks.test.ts (customers/redact) | done | plus a completeness test over every PII location |
| `test/services/repairs/event_payload_test.rb` | test/unit/repairs/outbound-webhook.test.ts | done |  |
| `test/services/repairs/intake_submission_test.rb` | test/integration/routes/proxy-intake.test.ts | done | covered end to end through the route (verification, import, token, duplicate, cover log, photos, webhook, notification) |
| `test/services/repairs/order_lookup_and_catalog_test.rb` | test/integration/services/repairs/order-lookup.test.ts + test/unit/shopify/{products,orders}.test.ts | done | lookup + Items + token in integration; catalogue + normalising in unit |
| `test/services/repairs/payment_processor_test.rb` | test/integration/services/payments/repair-payment.test.ts | done | adds concurrent deliveries, draft-order fallback, cross-shop |
| `test/services/repairs/product_catalog_test.rb` | test/unit/shopify/products.test.ts | done |  |
| `test/services/repairs/purchase_history_test.rb` | test/unit/shopify/orders.test.ts | done |  |
| `test/services/repairs/quote_canceller_test.rb` | test/integration/services/quotes/cancel-and-revise.test.ts | done | + reviseQuote |
| `test/services/repairs/quote_decision_test.rb` | test/integration/services/quotes/decision.test.ts | done | adds concurrent declines |
| `test/services/repairs/quote_sender_test.rb` | test/integration/services/quotes/send.test.ts | done | adds priceOverride, outbound webhook, cross-shop |
| `test/services/repairs/webhook_delivery_test.rb` | test/unit/repairs/webhook-delivery.test.ts | done | asserts the ShopCare header names |
| `test/services/shopify/admin_api_test.rb` | test/unit/shopify/draft-orders.test.ts, graphql.test.ts | done | REST assertions → GraphQL operations/variables; adds throttling + userErrors |
| `test/services/shopify/customer_signing_key_test.rb` | test/unit/shopify/customer-signing-key.test.ts + test/integration/wiring/shop-proxy-wiring.test.ts | done | integration: afterAuth saves the key encrypted, publish failure retried |
| `test/services/shopify/customer_token_test.rb` | test/unit/customer-token.test.ts | done | the shopify-api duplicate was dropped (it accepted upper-case hex, Rails didn't); end-to-end with the Shop row key in test/integration/wiring/shop-proxy-wiring.test.ts |
| `test/services/trade_ins/trade_ins_test.rb` | test/integration/services/trade-ins/{workflow,credit-issuer,order-linker}.test.ts | done | Quoter + Workflow (adds concurrent credit), CreditIssuer, OrderLinker; Submission cases deferred with Submission |
| `test/services/warranty/cover_assigner_test.rb` | test/integration/services/warranty/cover-assigner.test.ts | done |  |

### Tests: jobs (3)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `test/jobs/after_authenticate_job_test.rb` | test/integration/jobs/jobs.test.ts | done | + paged import, failure, notification sweep, export prune |
| `test/jobs/outbound_webhook_job_test.rb` | test/unit/repairs/outbound-webhook.test.ts | done |  |
| `test/jobs/shop_webhook_jobs_test.rb` | test/integration/webhooks.test.ts | done | through the signed routes; + GDPR export, uninstall, trade-in link, repair payment |

### Tests: integration (request) (15)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `test/integration/admin_items_test.rb` | test/integration/routes/admin-catalog.test.ts (items) + admin-tickets.test.ts (linking) | done |  |
| `test/integration/admin_part_imports_test.rb` | test/integration/routes/admin-parts.test.ts (part imports) | done |  |
| `test/integration/admin_parts_test.rb` | test/integration/routes/admin-parts.test.ts + admin-settings.test.ts | done | completion is a mocked changeTicketStatus here; real stock use in ticket-status.test.ts and e2e scenario (a) |
| `test/integration/admin_quotes_test.rb` | test/integration/routes/admin-tickets.test.ts (quote actions) | done | quote services mocked here; tested in test/integration/services/quotes/* and the e2e scenarios |
| `test/integration/admin_repair_services_test.rb` | test/integration/routes/admin-setup-services.test.ts | done |  |
| `test/integration/admin_smoke_test.rb` | test/integration/routes/admin-tickets.test.ts + admin-settings.test.ts | done | iframe/bounce/idToken tests replaced by the authenticate.admin seam (signed-out test); loaders are asserted on data, not HTML |
| `test/integration/care_plans_test.rb` | test/integration/routes/proxy-care.test.ts + admin-catalog.test.ts + admin-settings.test.ts | done | storefront half split into 5; admin half in the admin route tests |
| `test/integration/product_groups_test.rb` | test/integration/routes/admin-catalog.test.ts | done |  |
| `test/integration/proxy_find_product_test.rb` | test/integration/routes/proxy-find-product.test.ts | done | 7/7; Admin API faked instead of stubbing services |
| `test/integration/proxy_intake_test.rb` | test/integration/routes/proxy-intake.test.ts | done | 5/5 + 9 IntakeSubmission cases |
| `test/integration/proxy_orders_test.rb` | test/integration/routes/proxy-orders.test.ts | done | 10/10 + uninstalled shop |
| `test/integration/proxy_quotes_test.rb` | test/integration/routes/proxy-quotes.test.ts | done | 9/9 + choice=decline; decisions via a stand-in here; the real decline through this page is e2e scenario (c) |
| `test/integration/proxy_status_test.rb` | test/integration/routes/proxy-status.test.ts | done | 5/5 |
| `test/integration/setup_test.rb` | test/integration/routes/admin-setup-services.test.ts | done |  |
| `test/integration/trade_ins_test.rb` | test/integration/routes/proxy-trade-ins.test.ts + admin-trade-ins.test.ts | done | storefront flag-off case + admin screens; flag-on storefront cases deferred with Submission |

### Tests: support and helpers (6)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `test/support/care_fixtures.rb` | test/support/factories.ts | done | `buildCare` |
| `test/support/fake_draft_order_api.rb` | test/support/fake-draft-orders.ts | done | `FakeDraftOrders` |
| `test/support/fake_graphql_api.rb` | test/support/fake-graphql-api.ts | done | done → test/support/fake-graphql.ts |
| `test/support/parts_fixtures.rb` | test/support/factories.ts | done | `buildWorkshop` |
| `test/support/proxy_signing.rb` | test/support/proxy-signing.ts | done | done → test/support/shopify-requests.ts `appProxyRequest` |
| `test/support/trade_in_fixtures.rb` | test/support/factories.ts | done | `buildProgram` |

### Tests: fixtures (2)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `test/fixtures/files/repair.png` | test/support/proxy-routes.ts | done | `pngFile()` (1×1 PNG) |
| `test/fixtures/shops.yml` | test/support/factories.ts | done | → factory `createShop` in test/support/factories.ts |

### Tests: storefront (3)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `test/storefront/package-lock.json` | (none) | done | dropped |
| `test/storefront/package.json` | package.json devDependencies | done | `jsdom` 24.1.3 and `liquidjs` 10.16.1, the versions Rails used |
| `test/storefront/storefront.test.js` | test/storefront/storefront.test.js | done | ported 16-10-2026 when the Repair status block gained "Download postage slip": the same journeys, ES module imports, one `it()` each, Vitest project `storefront` (`npm run test:storefront`); its proxy mocks are also replayed against the real routes in test/integration/routes/extension-contract.test.ts |

### Tests: helper (1)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `test/test_helper.rb` | vitest.config.ts + test/support/* | done | done → vitest.config.ts + test/support/{test-env,global-setup,integration-setup,db}.ts |


### Tests: end to end (v2, no Rails counterpart)

`test/integration/e2e/scenarios.test.ts` runs whole journeys through the real
routes and services (Postgres, Admin GraphQL fakes):

| Scenario | Path |
|---|---|
| (a) repair, start to finish | `/proxy/intake` → admin `addLineItem` → `sendQuote` → `orders/paid` (twice) → `awaiting_item` (the draft order carried the postage slip link for the order confirmation; `/proxy/status` links the slip) → `markItemReceived` → `in_repair` → `returnRepairedItem` (fulfilment with tracking, completed, recipe parts out of stock) → `/proxy/status` |
| (b) Care plan covers a repair | `orders/paid` with a Care line → cover → `/proxy/intake` for that item → £0 quote → `sendQuote` completes it (no invoice) |
| (c) decline on the review page | `/proxy/quotes/:token/decline` → quote declined, draft order deleted, staff `quote_declined` queued |
| (d) Care refund, duplicate delivery | `refunds/create` delivered twice at once → cover cancelled once, one processed refund, no Shopify refund call (the merchant already refunded the line) |
| (e) customer redaction | intake (with photo) + order → `customers/redact` → no trace of the customer in any table or stored file |
