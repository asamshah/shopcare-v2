# Porting ShopCare from Rails to TypeScript

Source of truth: the Rails app at git tag **`rails-reference`** (commit
`c8ea3ec`) in `../shopcare`. Every file under `app/` and `test/` at that tag is
listed below, with its planned module here. `extensions/`, `parked/` and
`docs/` were copied from the tag unchanged.

Status values: `todo` → `wip` → `done` (ported and its tests ported). Update
the row in the same commit as the code.

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
| `Rails.cache` | Nothing is shared between function instances: Postgres or Netlify Blobs, or the CDN for public responses |
| Minitest + fixtures + mocha | Vitest; `test/support/factories.ts` builders; fakes passed in as dependencies (`vi.fn()` for one-off mocks) |
| Model/service tests that touch the DB | `test/integration/**` (real Postgres, truncated per test) |
| Pure logic tests | `test/unit/**` |

## Config and infrastructure

| Rails | ShopCare v2 | Status | Notes |
|---|---|---|---|
| `shopify.app.toml` | `shopify.app.toml` | done | scopes, app proxy (`apps`/`repairs` → `/proxy`), compliance webhooks. client_id is blank until linked |
| `config/initializers/shopify_app.rb` (runtime webhooks) | `[[webhooks.subscriptions]]` in `shopify.app.toml` | done | app/uninstalled, orders/paid, refunds/create, 3 compliance topics; API version 2025-10 → 2026-10 |
| `config/initializers/shopify_app.rb` (`after_authenticate_job`) | `hooks.afterAuth` in `app/shopify.server.ts` | todo | enqueue the order backfill |
| `config/routes.rb` | `app/routes/*` (flat routes) | todo | proxy paths unchanged: `/proxy/intake`, `/proxy/status`, `/proxy/quotes/:token` (+ `/decline`), `/proxy/orders`, `/proxy/catalog_search`, `/proxy/order_lookup`, `/proxy/care_plans`, `/proxy/care_offers`, `/proxy/trade_in_options`, `/proxy/trade_ins` |
| `db/schema.rb` + `db/migrate/*` (26) | `prisma/schema.prisma` + `prisma/migrations/` | done | every domain table in one migration (`…_domain_schema`) on top of the template's `Session` migration; see [Schema notes](#schema-notes). Email settings go in `shops.settings` when the notifications are built |
| `config/recurring.yml` `expire_quotes` (daily 3am) | `netlify/functions/expire-quotes.mts` | todo | template: `netlify/functions/daily-example.mts` |
| `config/storage.yml` (Disk / S3) | `app/lib/storage.server.ts` | done | Netlify Blobs; signed URLs served by `app/routes/files.$.tsx` |
| `Shop` `encrypts` | `app/lib/encryption.server.ts` | done | key rotation via `APP_ENCRYPTION_PREVIOUS_KEYS`; `*_ciphertext` columns, read/written with `shopSecret` / `setShopSecret` in `app/models/shop.server.ts` |
| `config/initializers/content_security_policy.rb` | `addDocumentResponseHeaders` (library) | done | the library sets frame-ancestors |
| `test/storefront` CI job | `.github/workflows/ci.yml` | todo | add once the storefront journeys are ported |
| `bin/brakeman`, `bin/rubocop` | `npm run lint`, `npm run typecheck` | done | |
| Solid Queue / Solid Cache / Puma / Docker | Netlify Functions | done | `Dockerfile` kept from the template for self-hosting only |

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
- **Wiring / tests**: `configureAppProxy({...})` swaps `customerSigningKey`,
  `rememberPathPrefix`, `throttleStore`, `authenticate`, `now`; it returns a
  restore function. Integration tests use `appProxyRequest()` from
  `test/support/shopify-requests.ts`.

## Notifications (v2 design)

**Decision:** ShopCare sends its own customer and staff emails from code.
Shopify Flow triggers and Klaviyo events become **optional integrations**, not
the delivery mechanism. The quote/invoice email is still Shopify's own
draft-order invoice (`Repairs::QuoteSender` → `draftOrderInvoiceSend`),
unchanged.

Foundation in place: `app/services/email.server.ts`, which defines
`sendEmail({ shopId, to, subject, html, text, replyTo, fromName, tags,
idempotencyKey })` with a Resend adapter (default when `RESEND_API_KEY` is set)
and a `log` adapter (dev/test; captures messages). Provider types stay inside
the adapter, so a Postmark adapter can be added later.

Built (`app/services/notifications.server.ts` + `app/services/notifications/`):
templates, the dispatcher, the `notification` job, consent check, Flow and
Klaviyo clients. Still to wire at integration: the Prisma `NotificationStore`,
the shop settings loader, `setNotificationDeps()`, the unsubscribe route and
the Resend bounce/complaint webhook + suppression list.

### Emails

| Email | To | Trigger (Rails source) | Kind |
|---|---|---|---|
| Repair request received | customer (incl. guests) | intake submitted (`Repairs::IntakeSubmission`) | transactional, **new** |
| Repair status changed: assessing / in repair / ready / returned | customer | ticket status change (`repair_status_changed`) | transactional |
| Care plan welcome | customer | Care activated (`care_activated`) | transactional |
| Care credit code issued | customer | `care_credit_offer` (`Care::CreditIssuer`) | transactional |
| Add Care to your purchase | customer | `care_offer` | **marketing**: see consent rule |
| New repair request | staff | intake submitted | staff alert, **new** |
| Quote paid | staff | `quote_paid` (orders/paid) | staff alert |
| Quote declined (with reason) | staff | `quote_declined` | staff alert |
| Quote expired | staff | `quote_expired` (daily expiry job) | staff alert |

Staff alerts go to the **"Notify staff at"** address in Settings.

### Marketing consent

"Add Care to your purchase" is marketing. At send time, read the customer's
`emailMarketingConsent` via the Admin API (`customer(id) {
defaultEmailAddress { marketingState } }` / `emailMarketingConsent`; confirm
the field against the 2026-10 schema when building). Send only when the state
is `SUBSCRIBED`; otherwise mark the delivery `skipped` with the reason and log
it. Guests have no consent record, so they are always skipped.

### Branding

- From: `"<Store name> via ShopCare" <notifications@EMAIL_FROM_DOMAIN>`
  (`fromAddress()` already sanitises the display name).
- Reply-To: the merchant's support email (setting; defaults to the shop's
  contact email from `shop { contactEmail }`).
- Template header uses the store name and logo (from `shop.brand` or an upload
  in Settings).
- Later (optional): a verified custom sending domain per merchant (DNS records
  shown in Settings, verified through the provider's domains API).

### Settings (per shop)

- On/off toggle **per email**, so merchants already using Klaviyo or Flow for
  the same message can switch ShopCare's off and avoid duplicates.
- Editable subject and intro text per email, with defaults; the body
  structure stays fixed.
- Staff alert address ("Notify staff at").
- Support / Reply-To address.

### Reliability

- Never send inline from a request or webhook: create a
  `notification_deliveries` row, then `enqueue("notification", { deliveryId })`.
  The background function sends it, and on a retryable `EmailDeliveryError`
  (429/5xx/network) it throws so Netlify retries; it also records `attempts`
  and `last_error`.
- Idempotency key per event, `<event>:<record id>` (e.g.
  `repair_status_changed:ticket_42:ready`), with a **unique index** on
  `(shop_id, channel, idempotency_key)` in `notification_deliveries`. A
  duplicate webhook or retry finds the existing row and stops. The provider's
  `Idempotency-Key` is `<shop>:<channel>:<key>`, because provider keys are
  account-wide. Channels: `email` (customer), `staff_email`, `flow`,
  `klaviyo`; one event makes at most one row per channel.
- "Add Care to your purchase" is **off by default** (merchant opts in).
- `notification_deliveries` keeps its Rails role as the log merchants see
  (pending / sent / skipped / failed), with new channel `email`, plus
  `provider_message_id`, `idempotency_key`, `attempts`, `last_error`.
- Provider webhook (Resend: `email.bounced`, `email.complained`) → route
  `webhooks.email.tsx` (signature verified) marks the delivery and adds the
  address to a per-shop suppression list checked before every send.

### Optional integrations (unchanged set from `rails-reference`)

Flow triggers (`extensions/shopcare-flow-*`): care-activated, care-credit,
care-offer, quote-declined, quote-expired, quote-paid, repair-status; plus
`parked/shopcare-flow-trade-in-status`. Klaviyo metrics: the same events
(`Notifications::Dispatcher::EVENTS`). They are still emitted when the merchant
enables Flow or adds a Klaviyo key, independently of ShopCare's own emails.

### Compliance

- Transactional emails (request received, status, Care welcome, credit code,
  staff alerts) need no marketing consent.
- Every customer email footer includes the store's name and postal address
  (`shop.billingAddress` or a Settings value).
- An unsubscribe link (plus `List-Unsubscribe` / one-click headers) only on
  the marketing email; unsubscribing updates Shopify's
  `customerEmailMarketingConsentUpdate` so the store and ShopCare agree.

## Schema notes

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
- **notification_deliveries** gains v2 columns now: `idempotency_key`,
  `provider_message_id`, `attempts`, a unique index on
  `(shop_id, channel, idempotency_key)`, and the `email` channel. Rails'
  `error` column keeps the last error.
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
| `app/models/notification_delivery.rb` | prisma/schema.prisma `NotificationDelivery` + app/models/notification-delivery.server.ts | done | keeps its role as the per-event delivery log + idempotency record; adds channel "email" (see Notifications); `NotificationStore` interface + in-memory store in app/services/notifications/store.server.ts, Prisma implementation pending (integration) |
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
| `app/services/care/activator.rb` | app/services/care/activator.server.ts | todo |  |
| `app/services/care/credit_issuer.rb` | app/services/care/credit-issuer.server.ts | todo |  |
| `app/services/care/notices.rb` | app/services/care/notices.server.ts | todo |  |
| `app/services/care/plan_economics.rb` | app/services/care/plan-economics.server.ts | todo |  |
| `app/services/care/plan_refunder.rb` | app/services/care/plan-refunder.server.ts | todo |  |
| `app/services/care/plan_terms.rb` | app/services/care/plan-terms.server.ts | done | pure function; tests are in care-plan.test.ts (Rails tested it via care_plan_test) |
| `app/services/care/refund_handler.rb` | app/services/care/refund-handler.server.ts | todo |  |
| `app/services/items/order_data.rb` | app/services/items/order-data.server.ts | todo |  |
| `app/services/items/order_importer.rb` | app/services/items/order-importer.server.ts | todo | runs in background job, cursor-paged |
| `app/services/items/owned_item_resolver.rb` | app/services/items/owned-item-resolver.server.ts | todo |  |
| `app/services/items/recorder.rb` | app/services/items/recorder.server.ts | todo |  |
| `app/services/items/refund_processor.rb` | app/services/items/refund-processor.server.ts | todo |  |
| `app/services/items/registration_submission.rb` | app/services/items/registration-submission.server.ts | todo |  |
| `app/services/notifications/delivery_error.rb` | app/services/notifications/delivery-error.server.ts | done | adds `retryable` |
| `app/services/notifications/dispatcher.rb` | app/services/notifications.server.ts (`emitNotification`, `deliverNotification`) + notifications/events.server.ts (EVENTS) | done | v2: email + staff_email channels, per-email toggles, consent at send time; templates in notifications/templates.server.ts. Deps wired by `setNotificationDeps()` at integration |
| `app/services/notifications/flow_client.rb` | app/services/notifications/flow-client.server.ts | done | optional integration, unchanged trigger set; GraphQL client injected |
| `app/services/notifications/klaviyo_client.rb` | app/services/notifications/klaviyo-client.server.ts | done | optional integration, unchanged event set; only 429/5xx/network retried |
| `app/services/parts/consumer.rb` | app/services/parts/consumer.server.ts | todo |  |
| `app/services/parts/csv_export.rb` | app/services/parts/csv-export.server.ts | todo |  |
| `app/services/parts/csv_import.rb` | app/services/parts/csv-import.server.ts | todo | upload → storage.server.ts; long imports → background job |
| `app/services/parts/item_properties.rb` | app/services/parts/item-properties.server.ts | todo |  |
| `app/services/parts/matcher.rb` | app/services/parts/matcher.server.ts | todo |  |
| `app/services/parts/planner.rb` | app/services/parts/planner.server.ts | todo |  |
| `app/services/parts/reorder_list.rb` | app/services/parts/reorder-list.server.ts | todo |  |
| `app/services/parts/service_sync.rb` | app/services/parts/service-sync.server.ts | todo |  |
| `app/services/parts/ticket_costs.rb` | app/services/parts/ticket-costs.server.ts | todo |  |
| `app/services/repairs/catalog_search.rb` | app/services/repairs/catalog-search.server.ts | todo |  |
| `app/services/repairs/customer_redactor.rb` | app/services/repairs/customer-redactor.server.ts | todo |  |
| `app/services/repairs/event_payload.rb` | app/services/repairs/event-payload.server.ts | done | takes plain ticket/quotation objects |
| `app/services/repairs/intake_submission.rb` | app/services/repairs/intake-submission.server.ts | todo |  |
| `app/services/repairs/order_lookup.rb` | app/services/repairs/order-lookup.server.ts | todo |  |
| `app/services/repairs/payment_processor.rb` | app/services/repairs/payment-processor.server.ts | todo |  |
| `app/services/repairs/product_cards.rb` | app/services/repairs/product-cards.server.ts | todo |  |
| `app/services/repairs/product_catalog.rb` | app/services/repairs/product-catalog.server.ts | todo |  |
| `app/services/repairs/purchase_history.rb` | app/services/repairs/purchase-history.server.ts | todo |  |
| `app/services/repairs/quote_canceller.rb` | app/services/repairs/quote-canceller.server.ts | todo |  |
| `app/services/repairs/quote_decision.rb` | app/services/repairs/quote-decision.server.ts | todo |  |
| `app/services/repairs/quote_draft_order.rb` | app/services/repairs/quote-draft-order.server.ts | todo |  |
| `app/services/repairs/quote_notifications.rb` | app/services/repairs/quote-notifications.server.ts | todo | call `emitNotification("quote_paid"\|"quote_declined"\|"quote_expired", …)`; field mapping already in notifications/events.server.ts |
| `app/services/repairs/quote_sender.rb` | app/services/repairs/quote-sender.server.ts | todo |  |
| `app/services/repairs/webhook_delivery.rb` | app/services/repairs/webhook-delivery.server.ts | done | SSRF guard: strict outside development/test, every resolved address public (wider ranges than Rails), connection pinned, no redirects |
| `app/services/shopify/admin_api.rb` | app/services/shopify/admin-api.server.ts | todo | → thin wrapper over `admin.graphql` / `unauthenticated.admin(shop)`; tests use test/support/fake-graphql.ts |
| `app/services/shopify/customer_signing_key.rb` | app/services/shopify/customer-signing-key.server.ts | todo | uses encryption.server.ts |
| `app/services/shopify/customer_token.rb` | app/services/shopify/customer-token.server.ts | done | takes the key instead of the shop; the key lookup is injected (`AppProxyDeps.customerSigningKey`) |
| `app/services/shopify/discount_codes.rb` | app/services/shopify/discount-codes.server.ts | todo |  |
| `app/services/shopify/gid.rb` | app/services/shopify/gid.server.ts | done | `numericId` / `buildGid`; no Rails test |
| `app/services/trade_ins/credit_issuer.rb` | app/services/trade_ins/credit-issuer.server.ts | todo |  |
| `app/services/trade_ins/order_linker.rb` | app/services/trade_ins/order-linker.server.ts | todo |  |
| `app/services/trade_ins/quoter.rb` | app/services/trade_ins/quoter.server.ts | todo |  |
| `app/services/trade_ins/submission.rb` | app/services/trade_ins/submission.server.ts | todo |  |
| `app/services/trade_ins/workflow.rb` | app/services/trade_ins/workflow.server.ts | todo |  |
| `app/services/warranty/cover_assigner.rb` | app/services/warranty/cover-assigner.server.ts | todo |  |
| `app/services/warranty/product_facts.rb` | app/services/warranty/product-facts.server.ts | wip | the `Facts` struct is ported as `ProductFacts` (app/models/product-facts.ts); the Shopify fetch is still todo |

### Controllers: proxy (storefront) (9)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/controllers/proxy/base_controller.rb` | app/lib/app-proxy.server.ts | wip | `authenticateProxy` + `proxyRoute` done (see [App Proxy routes](#app-proxy-routes)); needs integration wiring: `customerSigningKey`, `rememberPathPrefix`, Postgres throttle store |
| `app/controllers/proxy/care_controller.rb` | app/routes/proxy.care_plans.tsx, proxy.care_offers.tsx | todo | care_plans is public per product → CDN-cacheable (Netlify-Vary: query=shop\|product_id); care_offers is per customer → no-store |
| `app/controllers/proxy/catalog_controller.rb` | app/routes/proxy.catalog_search.tsx | todo | public catalogue facts → CDN-cacheable on query; keep throttling |
| `app/controllers/proxy/intake_controller.rb` | app/routes/proxy.intake.tsx | todo | POST multipart; photos → storage.server.ts |
| `app/controllers/proxy/order_lookups_controller.rb` | app/routes/proxy.order_lookup.tsx | todo | POST, rate-limited |
| `app/controllers/proxy/orders_controller.rb` | app/routes/proxy.orders.tsx | todo | per customer → no-store |
| `app/controllers/proxy/quotes_controller.rb` | app/routes/proxy.quotes.$token.tsx (+ .decline) | todo | renders an HTML page through the proxy (views/proxy/quotes/show) → return Liquid/HTML with Content-Type application/liquid |
| `app/controllers/proxy/status_controller.rb` | app/routes/proxy.status.tsx | todo | per customer → no-store |
| `app/controllers/proxy/trade_ins_controller.rb` | app/routes/proxy.trade_in_options.tsx, proxy.trade_ins.tsx | todo | trade_in_options public per shop → cacheable |

### Controllers: admin (embedded) (22)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/controllers/admin_controller.rb` | app/routes/app.tsx / app/shopify.server.ts | todo | → app/routes/app.tsx layout (nav) |
| `app/controllers/application_controller.rb` | app/routes/app.tsx / app/shopify.server.ts | todo | → app/root.tsx / shopify.server.ts |
| `app/controllers/authenticated_controller.rb` | app/routes/app.tsx / app/shopify.server.ts | todo | → `authenticate.admin` in app/routes/app.tsx loader |
| `app/controllers/care_plans_controller.rb` | app/routes/app.care_plans*.tsx | todo |  |
| `app/controllers/concerns/proxy_throttling.rb` | app/lib/proxy-throttling.server.ts | wip | decided: Postgres upsert counter (`postgresThrottleStore`); table pending in `prisma/pending/proxy_throttles.sql` until added to the schema; prune old rows daily |
| `app/controllers/items_controller.rb` | app/routes/app.items*.tsx | todo |  |
| `app/controllers/part_imports_controller.rb` | app/routes/app.part_imports*.tsx | todo |  |
| `app/controllers/part_variants_controller.rb` | app/routes/app.part_variants*.tsx | todo |  |
| `app/controllers/parts_controller.rb` | app/routes/app.parts*.tsx | todo |  |
| `app/controllers/product_groups_controller.rb` | app/routes/app.product_groups*.tsx | todo |  |
| `app/controllers/quotation_line_items_controller.rb` | app/routes/app.quotation_line_items*.tsx | todo |  |
| `app/controllers/quotations_controller.rb` | app/routes/app.quotations*.tsx | todo |  |
| `app/controllers/registrations_controller.rb` | app/routes/app.registrations*.tsx | todo |  |
| `app/controllers/repair_services_controller.rb` | app/routes/app.repair_services*.tsx | todo |  |
| `app/controllers/service_components_controller.rb` | app/routes/app.service_components*.tsx | todo |  |
| `app/controllers/settings_controller.rb` | app/routes/app.settings*.tsx | todo |  |
| `app/controllers/setup_controller.rb` | app/routes/app.setup*.tsx | todo |  |
| `app/controllers/ticket_parts_controller.rb` | app/routes/app.ticket_parts*.tsx | todo |  |
| `app/controllers/tickets_controller.rb` | app/routes/app.tickets*.tsx | todo |  |
| `app/controllers/trade_in_programs_controller.rb` | app/routes/app.trade_in_programs*.tsx | todo |  |
| `app/controllers/trade_ins_controller.rb` | app/routes/app.trade_ins*.tsx | todo |  |
| `app/controllers/warranty_policies_controller.rb` | app/routes/app.warranty_policies*.tsx | todo |  |

### Jobs (13)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/jobs/after_authenticate_job.rb` | app/jobs/after-authenticate.server.ts | todo | shopify_app `after_authenticate_job` → `afterAuth` hook in shopify.server.ts → enqueue("import-orders") |
| `app/jobs/app_uninstalled_job.rb` | app/routes/webhooks.app.uninstalled.tsx | todo | extend routes/webhooks.app.uninstalled.tsx (template deletes sessions only) |
| `app/jobs/application_job.rb` | app/jobs/registry.server.ts | done | → app/jobs/registry.server.ts (done: pattern) |
| `app/jobs/customers_data_request_job.rb` | app/jobs/webhooks/customers-data-request.server.ts | todo | `webhook` job handler CUSTOMERS_DATA_REQUEST |
| `app/jobs/customers_redact_job.rb` | app/jobs/webhooks/customers-redact.server.ts | todo | `webhook` job handler CUSTOMERS_REDACT |
| `app/jobs/expire_quotes_job.rb` | app/jobs/expire-quotes.server.ts | todo | daily 03:00 (config/recurring.yml) → scheduled function `netlify/functions/expire-quotes.mts` → enqueue |
| `app/jobs/import_orders_job.rb` | app/jobs/import-orders.server.ts | todo | may exceed 15 min on big shops: page through and re-enqueue itself with a cursor |
| `app/jobs/notification_job.rb` | app/jobs/notification.server.ts | done | one delivery per invocation; retryable errors rethrown until attempts = 3, then failed |
| `app/jobs/orders_paid_job.rb` | app/jobs/webhooks/orders-paid.server.ts | todo | `webhook` job handler ORDERS_PAID |
| `app/jobs/outbound_webhook_job.rb` | app/jobs/outbound-webhook.server.ts | done | job `outbound-webhook`; `emitOutboundWebhook()`; context loader wired by `setOutboundWebhookDeps()` at integration |
| `app/jobs/refunds_create_job.rb` | app/jobs/webhooks/refunds-create.server.ts | todo | `webhook` job handler REFUNDS_CREATE |
| `app/jobs/shop_redact_job.rb` | app/jobs/webhooks/shop-redact.server.ts | todo | `webhook` job handler SHOP_REDACT |
| `app/jobs/shop_webhook_job.rb` | app/jobs/webhooks/shop-webhook.server.ts | todo | base class → shared helper in app/jobs/webhook.server.ts |

### Views (42)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/views/care_plans/_form.html.erb` | app/routes/app.care_plans* (component) | todo |  |
| `app/views/care_plans/edit.html.erb` | app/routes/app.care_plans* (component) | todo |  |
| `app/views/care_plans/index.html.erb` | app/routes/app.care_plans* (component) | todo |  |
| `app/views/care_plans/new.html.erb` | app/routes/app.care_plans* (component) | todo |  |
| `app/views/care_plans/show.html.erb` | app/routes/app.care_plans* (component) | todo |  |
| `app/views/items/index.html.erb` | app/routes/app.items* (component) | todo |  |
| `app/views/items/show.html.erb` | app/routes/app.items* (component) | todo |  |
| `app/views/layouts/_flash_messages.html.erb` | app/root.tsx / app/routes/app.tsx | todo | → Polaris toast via App Bridge (`shopify.toast.show`) |
| `app/views/layouts/application.html.erb` | app/root.tsx / app/routes/app.tsx | todo | → app/root.tsx |
| `app/views/layouts/embedded_app.html.erb` | app/root.tsx / app/routes/app.tsx | todo | → app/routes/app.tsx (AppProvider + s-app-nav) |
| `app/views/part_imports/new.html.erb` | app/routes/app.part_imports* (component) | todo |  |
| `app/views/part_imports/show.html.erb` | app/routes/app.part_imports* (component) | todo |  |
| `app/views/parts/_form.html.erb` | app/routes/app.parts* (component) | todo |  |
| `app/views/parts/edit.html.erb` | app/routes/app.parts* (component) | todo |  |
| `app/views/parts/index.html.erb` | app/routes/app.parts* (component) | todo |  |
| `app/views/parts/new.html.erb` | app/routes/app.parts* (component) | todo |  |
| `app/views/parts/reorder.html.erb` | app/routes/app.parts* (component) | todo |  |
| `app/views/parts/show.html.erb` | app/routes/app.parts* (component) | todo |  |
| `app/views/product_groups/_form.html.erb` | app/routes/app.product_groups* (component) | todo |  |
| `app/views/product_groups/_select.html.erb` | app/routes/app.product_groups* (component) | todo |  |
| `app/views/product_groups/edit.html.erb` | app/routes/app.product_groups* (component) | todo |  |
| `app/views/product_groups/index.html.erb` | app/routes/app.product_groups* (component) | todo |  |
| `app/views/product_groups/new.html.erb` | app/routes/app.product_groups* (component) | todo |  |
| `app/views/proxy/quotes/show.html.erb` | app/routes/proxy.quotes.$token.tsx | todo | storefront quote review page via App Proxy |
| `app/views/repair_services/_service.html.erb` | app/routes/app.repair_services* (component) | todo |  |
| `app/views/repair_services/edit.html.erb` | app/routes/app.repair_services* (component) | todo |  |
| `app/views/repair_services/index.html.erb` | app/routes/app.repair_services* (component) | todo |  |
| `app/views/settings/show.html.erb` | app/routes/app.settings* (component) | todo |  |
| `app/views/setup/_wizard.html.erb` | app/routes/app.setup* (component) | todo |  |
| `app/views/tickets/_quote_decision.html.erb` | app/routes/app.tickets* (component) | todo |  |
| `app/views/tickets/index.html.erb` | app/routes/app.tickets* (component) | todo |  |
| `app/views/tickets/show.html.erb` | app/routes/app.tickets* (component) | todo |  |
| `app/views/trade_in_programs/_form.html.erb` | app/routes/app.trade_in_programs* (component) | todo |  |
| `app/views/trade_in_programs/edit.html.erb` | app/routes/app.trade_in_programs* (component) | todo |  |
| `app/views/trade_in_programs/index.html.erb` | app/routes/app.trade_in_programs* (component) | todo |  |
| `app/views/trade_in_programs/new.html.erb` | app/routes/app.trade_in_programs* (component) | todo |  |
| `app/views/trade_ins/index.html.erb` | app/routes/app.trade_ins* (component) | todo |  |
| `app/views/trade_ins/show.html.erb` | app/routes/app.trade_ins* (component) | todo |  |
| `app/views/warranty_policies/_form.html.erb` | app/routes/app.warranty_policies* (component) | todo |  |
| `app/views/warranty_policies/edit.html.erb` | app/routes/app.warranty_policies* (component) | todo |  |
| `app/views/warranty_policies/index.html.erb` | app/routes/app.warranty_policies* (component) | todo |  |
| `app/views/warranty_policies/new.html.erb` | app/routes/app.warranty_policies* (component) | todo |  |

### Helpers (5)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/helpers/items_helper.rb` | app/lib/items-format.ts | todo |  |
| `app/helpers/liquid_helper.rb` | app/lib/http.server.ts (`liquidText`, `liquidResponse`) | done | |
| `app/helpers/parts_helper.rb` | app/lib/parts-format.ts | todo |  |
| `app/helpers/tickets_helper.rb` | app/lib/tickets-format.ts | todo |  |
| `app/helpers/trade_ins_helper.rb` | app/lib/trade-ins-format.ts | todo |  |

### Assets (1)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/assets/stylesheets/application.css` | (none) | todo | → Polaris web components; drop custom CSS where possible |

### JavaScript (1)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `app/javascript/application.js` | (none) | todo | → not needed (React) |

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
| `test/services/care/activator_test.rb` | test/integration/services/care/activator.test.ts | todo |  |
| `test/services/care/notices_and_economics_test.rb` | test/integration/services/care/notices-and-economics.test.ts | todo |  |
| `test/services/care/refund_handler_test.rb` | test/integration/services/care/refund-handler.test.ts | todo |  |
| `test/services/items/order_data_test.rb` | test/integration/services/items/order-data.test.ts | todo |  |
| `test/services/items/order_importer_test.rb` | test/integration/services/items/order-importer.test.ts | todo |  |
| `test/services/items/recorder_test.rb` | test/integration/services/items/recorder.test.ts | todo |  |
| `test/services/items/refund_processor_test.rb` | test/integration/services/items/refund-processor.test.ts | todo |  |
| `test/services/items/registration_submission_test.rb` | test/integration/services/items/registration-submission.test.ts | todo |  |
| `test/services/notifications/notifications_test.rb` | test/unit/notifications/{notifications,integrations,templates}.test.ts | done | pure (in-memory store); adds consent, toggles, idempotency, retries, escaping, snapshots, Flow TOML parity. Encryption-at-rest of the Klaviyo key goes with the Shop model |
| `test/services/parts/csv_import_test.rb` | test/integration/services/parts/csv-import.test.ts | todo |  |
| `test/services/parts/item_properties_test.rb` | test/integration/services/parts/item-properties.test.ts | todo |  |
| `test/services/parts/planning_test.rb` | test/integration/services/parts/planning.test.ts | todo |  |
| `test/services/parts/reorder_and_sync_test.rb` | test/integration/services/parts/reorder-and-sync.test.ts | todo |  |
| `test/services/repairs/customer_redactor_test.rb` | test/integration/services/repairs/customer-redactor.test.ts | todo |  |
| `test/services/repairs/event_payload_test.rb` | test/unit/repairs/outbound-webhook.test.ts | done |  |
| `test/services/repairs/intake_submission_test.rb` | test/integration/services/repairs/intake-submission.test.ts | todo |  |
| `test/services/repairs/order_lookup_and_catalog_test.rb` | test/integration/services/repairs/order-lookup-and-catalog.test.ts | todo |  |
| `test/services/repairs/payment_processor_test.rb` | test/integration/services/repairs/payment-processor.test.ts | todo |  |
| `test/services/repairs/product_catalog_test.rb` | test/integration/services/repairs/product-catalog.test.ts | todo |  |
| `test/services/repairs/purchase_history_test.rb` | test/integration/services/repairs/purchase-history.test.ts | todo |  |
| `test/services/repairs/quote_canceller_test.rb` | test/integration/services/repairs/quote-canceller.test.ts | todo |  |
| `test/services/repairs/quote_decision_test.rb` | test/integration/services/repairs/quote-decision.test.ts | todo |  |
| `test/services/repairs/quote_sender_test.rb` | test/integration/services/repairs/quote-sender.test.ts | todo |  |
| `test/services/repairs/webhook_delivery_test.rb` | test/unit/repairs/webhook-delivery.test.ts | done |  |
| `test/services/shopify/admin_api_test.rb` | test/integration/services/shopify/admin-api.test.ts | todo |  |
| `test/services/shopify/customer_signing_key_test.rb` | test/integration/services/shopify/customer-signing-key.test.ts | todo |  |
| `test/services/shopify/customer_token_test.rb` | test/unit/customer-token.test.ts | done | "encrypted at rest" case moves to the Shop model port; proxy_orders token cases are in test/unit/app-proxy.test.ts |
| `test/services/trade_ins/trade_ins_test.rb` | test/integration/services/trade_ins/trade-ins.test.ts | todo |  |
| `test/services/warranty/cover_assigner_test.rb` | test/integration/services/warranty/cover-assigner.test.ts | todo |  |

### Tests: jobs (3)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `test/jobs/after_authenticate_job_test.rb` | test/integration/jobs/after-authenticate-job.test.ts | todo |  |
| `test/jobs/outbound_webhook_job_test.rb` | test/unit/repairs/outbound-webhook.test.ts | done |  |
| `test/jobs/shop_webhook_jobs_test.rb` | test/integration/jobs/shop-webhook-jobs.test.ts | todo |  |

### Tests: integration (request) (15)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `test/integration/admin_items_test.rb` | test/integration/routes/admin-items.test.ts | todo |  |
| `test/integration/admin_part_imports_test.rb` | test/integration/routes/admin-part-imports.test.ts | todo |  |
| `test/integration/admin_parts_test.rb` | test/integration/routes/admin-parts.test.ts | todo |  |
| `test/integration/admin_quotes_test.rb` | test/integration/routes/admin-quotes.test.ts | todo |  |
| `test/integration/admin_repair_services_test.rb` | test/integration/routes/admin-repair-services.test.ts | todo |  |
| `test/integration/admin_smoke_test.rb` | test/integration/routes/admin-smoke.test.ts | todo |  |
| `test/integration/care_plans_test.rb` | test/integration/routes/care-plans.test.ts | todo |  |
| `test/integration/product_groups_test.rb` | test/integration/routes/product-groups.test.ts | todo |  |
| `test/integration/proxy_find_product_test.rb` | test/integration/routes/proxy-find-product.test.ts | todo |  |
| `test/integration/proxy_intake_test.rb` | test/integration/routes/proxy-intake.test.ts | todo |  |
| `test/integration/proxy_orders_test.rb` | test/integration/routes/proxy-orders.test.ts | todo |  |
| `test/integration/proxy_quotes_test.rb` | test/integration/routes/proxy-quotes.test.ts | todo |  |
| `test/integration/proxy_status_test.rb` | test/integration/routes/proxy-status.test.ts | todo |  |
| `test/integration/setup_test.rb` | test/integration/routes/setup.test.ts | todo |  |
| `test/integration/trade_ins_test.rb` | test/integration/routes/trade-ins.test.ts | todo |  |

### Tests: support and helpers (6)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `test/support/care_fixtures.rb` | test/support/care-fixtures.ts | todo |  |
| `test/support/fake_draft_order_api.rb` | test/support/fake-draft-order-api.ts | todo |  |
| `test/support/fake_graphql_api.rb` | test/support/fake-graphql-api.ts | done | done → test/support/fake-graphql.ts |
| `test/support/parts_fixtures.rb` | test/support/parts-fixtures.ts | todo |  |
| `test/support/proxy_signing.rb` | test/support/proxy-signing.ts | done | done → test/support/shopify-requests.ts `appProxyRequest` |
| `test/support/trade_in_fixtures.rb` | test/support/trade-in-fixtures.ts | todo |  |

### Tests: fixtures (2)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `test/fixtures/files/repair.png` | test/support/factories.ts | todo | copy when intake tests are ported |
| `test/fixtures/shops.yml` | test/support/factories.ts | todo | → factory `createShop` in test/support/factories.ts |

### Tests: storefront (3)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `test/storefront/package-lock.json` | test/storefront/ | todo | drop |
| `test/storefront/package.json` | test/storefront/ | todo | fold devDeps (jsdom, liquidjs) into root |
| `test/storefront/storefront.test.js` | test/storefront/ | todo | Liquid+jsdom journeys over extensions/repair-intake; port as a Vitest project (environment: jsdom) or keep as a node script |

### Tests: helper (1)

| Rails file | Planned TS module | Status | Notes |
|---|---|---|---|
| `test/test_helper.rb` | vitest.config.ts + test/support/* | done | done → vitest.config.ts + test/support/{test-env,global-setup,integration-setup,db}.ts |

