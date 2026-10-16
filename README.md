# ShopCare v2

ShopCare (repairs, Care plans, warranty, trade-ins for Shopify merchants)
rewritten in TypeScript. It started from Shopify's
[React Router app template](https://github.com/Shopify/shopify-app-template-react-router)
and runs on Netlify with Postgres (Neon).

The Rails app it replaces is frozen at tag `rails-reference` in `../shopcare`.
[`docs/PORTING.md`](docs/PORTING.md) maps every Rails file to its planned
module here and tracks progress. It also holds the
[Notifications (v2 design)](docs/PORTING.md#notifications-v2-design): ShopCare
sends its own emails, and Flow and Klaviyo become optional integrations.

## What runs where

| Shopify-hosted (deployed with `shopify app deploy`) | Netlify-hosted (deployed by Netlify from git) |
|---|---|
| App config: scopes, webhook subscriptions, App Proxy (`shopify.app.toml`) | Embedded admin UI and loaders/actions (React Router SSR in a Netlify Function) |
| Theme app extension `extensions/repair-intake` (storefront blocks, JS, CSS) | App Proxy endpoints: storefront `/apps/repairs/*` → `/proxy/*` |
| Flow trigger extensions `extensions/shopcare-flow-*` | Webhook endpoints `/webhooks/*` |
| Draft-order invoice emails (Shopify sends them) | Background jobs (`netlify/functions/jobs-background.mts`) and scheduled jobs |
| | Files (Netlify Blobs), ShopCare's own emails (Resend) |
| | Postgres: Neon (directly or via Netlify DB) |

## Layout

```
app/
  routes/            React Router routes: app.* (admin), proxy.* (App Proxy), webhooks.* (Shopify +
                     webhooks.email for Resend), email.unsubscribe, files.$
  components/        admin UI pieces (Polaris web components): forms, flash toast, downloads
  models/            one module per Rails model: validations, enums, business rules (plain functions over Prisma rows)
  shopify/           Admin API (GraphQL) calls: draft orders, discounts, store credit, orders, products, shop
  lib/               infrastructure and pure helpers: encryption, signing, GIDs, customer token, storage,
                     background dispatch, webhooks, http caching, row locks, Postgres cache, proxy throttling
  services/          domain services (Rails app/services): notifications, items, care, warranty, repairs,
                     quotes (send/resend/revise/decision/cancel: the shared service contract),
                     payments, gdpr (customer export + redaction, shop redaction), parts, trade-ins,
                     storefront/* (App Proxy endpoints), admin/* (admin screens' loaders/actions logic)
  jobs/              background job handlers + registry (webhook, notification, import-orders,
                     outbound-webhook, care-offers, expire-quotes, notification-sweep, …)
  shopify.server.ts  @shopify/shopify-app-react-router setup (Prisma session storage)
  db.server.ts       Prisma client
netlify/functions/   jobs-background.mts (Background Function); Scheduled: daily-prune.mts
                     (throttle + cache rows, old GDPR exports), daily-care-offers.mts ("Add Care"
                     offer), daily-expire-quotes.mts, hourly-notification-sweep.mts
prisma/              schema + migrations (Postgres; every Rails table, see docs/PORTING.md#schema-notes)
extensions/          theme app extension + Flow triggers (copied unchanged from Rails)
parked/              Flow trigger not yet shipped (trade-in status)
test/unit/           pure tests
test/integration/    tests against a real Postgres (routes, services, webhooks; e2e/ = whole journeys)
test/support/        DB reset, factories, Shopify-signed request builders, fakes
docs/                PORTING.md, BACKGROUND-WORK.md, and the Rails docs (ROADMAP, GOING-LIVE, …)
```

## Run locally

Requirements: Node 22.12+, Docker, the [Shopify CLI](https://shopify.dev/docs/apps/tools/cli).

1. **Postgres** (container `shopcare-v2-pg` on port 55433):

   ```shell
   docker run -d --name shopcare-v2-pg -p 55433:5432 \
     -e POSTGRES_USER=shopcare -e POSTGRES_PASSWORD=shopcare -e POSTGRES_DB=shopcare_dev \
     postgres:17-alpine
   ```

2. **Env:** `cp .env.example .env` and set `APP_ENCRYPTION_KEY`
   (`openssl rand -base64 32`). The database URLs already point at the container.

3. **Install and migrate:**

   ```shell
   npm install
   npx prisma migrate dev
   ```

4. **Link and run** (first time: link to the ShopCare app or a dev app):

   ```shell
   npm run config:link
   npm run dev            # shopify app dev: tunnel, env vars, migrate deploy, react-router dev
   ```

   Locally, background jobs run in-process (`BACKGROUND_DISPATCH=inline`),
   files go to `./.storage`, and emails are printed (log adapter) unless
   `RESEND_API_KEY` is set.

## Test

```shell
npm test                    # unit + integration
npm run test:unit           # no database needed (unit tests never touch Postgres)
npm run test:integration    # needs the Postgres container
npm run typecheck
npm run lint
```

Integration tests use the `shopcare_test` database on the same container
(override with `TEST_DATABASE_URL`). It's migrated once per run
(`prisma migrate deploy` creates it if missing) and truncated before every
test. Test env vars are fixed in `test/support/test-env.ts`, so your `.env`
doesn't leak in. Patterns ported from the Rails suite:

- `test/support/factories.ts`: `build*` / `create*` fixture builders (Rails `*_fixtures.rb`)
- `test/support/shopify-requests.ts`: real HMAC-signed App Proxy and webhook requests (Rails `ProxySigning`)
- `test/support/fake-graphql.ts`: Admin GraphQL fake matched by query fragment (Rails `FakeGraphqlApi`)
- Services take their Shopify client as a dependency, so tests pass a fake (Rails `api:` kwargs)
- `test/support/orders.ts`: `OrderData` / GraphQL order node builders for recorder and lookup tests

Production wiring is the default outside Vitest: the Postgres notification
store and Shop-row settings, the Postgres throttle store and shared cache
(`cache_entries`), the Shop row's customer signing key. Under Vitest those
defaults are in-memory or must be set explicitly (`setNotificationDeps`,
`configureAppProxy`, `setDefaultShopifyCache`, `setOutboundWebhookDeps`,
`setWebhookJobDeps`, `setImportOrdersDeps`). Quote/ticket services take
`client` (the Admin GraphQL client) and `enqueue` options; tests pass
`FakeDraftOrders` (test/support/fake-draft-orders.ts) and the
test/support/quotes.ts fixtures.

CI (`.github/workflows/ci.yml`) runs install, `prisma generate`,
`prisma migrate deploy` against a Postgres service container, then typecheck,
lint, tests and the Netlify build.

## Environment variables

All are in [`.env.example`](.env.example) with comments. On Netlify set them
under Site configuration → Environment variables.

| Variable | Needed | What |
|---|---|---|
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | always | the app's client credentials (`shopify app env show`) |
| `SCOPES` | always | must match `[access_scopes]` in `shopify.app.toml` |
| `SHOPIFY_APP_URL` | always | the Netlify site URL in production (the CLI sets the tunnel in dev) |
| `DATABASE_URL` / `DIRECT_URL` | always | Neon pooled / direct connection strings |
| `APP_ENCRYPTION_KEY` | always | `openssl rand -base64 32`; never change it without moving the old one to `APP_ENCRYPTION_PREVIOUS_KEYS` |
| `BACKGROUND_DISPATCH` | Netlify | `netlify` |
| `RESEND_API_KEY`, `EMAIL_FROM_DOMAIN` | to send email | Resend key and the verified sending domain (without them emails are only logged) |
| `RESEND_WEBHOOK_SECRET` | with Resend | signing secret of the Resend webhook → `POST /webhooks/email` (bounces, complaints → suppression list) |
| `SHOPIFY_APP_HANDLE` | if not `shopcare` | the app's handle in admin URLs; staff emails link to `https://admin.shopify.com/store/<store>/apps/<handle>/app/tickets/<id>` |
| `EMAIL_DEFAULT_FROM_NAME`, `STORAGE_*`, `BACKGROUND_FUNCTIONS_URL`, `SHOP_CUSTOM_DOMAIN`, `APP_ENCRYPTION_PREVIOUS_KEYS` | optional | see `.env.example` |

## Deploy

ShopCare is already a Shopify app (Partner org *Hype Park*, client ID
`35f17691b22cc66e2dfa8324395f96d6`): link to it, don't create a new one. The
extension uids in `extensions/*/shopify.extension.toml` belong to it.

### 1. Database (Neon)

Create a Neon project (or enable Netlify DB, which provisions Neon). Copy the
**pooled** connection string (host contains `-pooler`, add
`?sslmode=require&pgbouncer=true&connect_timeout=15`) to `DATABASE_URL` and
the **direct** one to `DIRECT_URL`. Make a Neon branch for Deploy Previews and
Branch deploys: the build runs migrations, so those contexts need their own
database URLs.

### 2. Email (Resend)

Add and verify the sending domain (`EMAIL_FROM_DOMAIN`, e.g.
`mail.shopcare.app`; mail goes from `notifications@` it), create an API key
(`RESEND_API_KEY`), and add a webhook to `https://<site>/webhooks/email` for
`email.bounced` and `email.complained`; its signing secret is
`RESEND_WEBHOOK_SECRET`.

### 3. Netlify (the app server)

The build uses Netlify's official React Router adapter,
[`@netlify/vite-plugin-react-router`](https://docs.netlify.com/frameworks/react-router/)
(in `vite.config.ts`): SSR, loaders and actions run in a Netlify Function.
`netlify.toml` sets the build (`npm run build:netlify`: `prisma generate`,
`prisma migrate deploy`, `react-router build`), publish dir `build/client`,
our functions in `netlify/functions/` (background jobs + the scheduled ones:
prune, care offers, quote expiry, notification sweep) and bundles Prisma's
engine.

1. New site from the git repo, production branch `main`.
2. Set the environment variables above (`SHOPIFY_APP_URL` = the site URL,
   `BACKGROUND_DISPATCH=netlify`), with the Neon branch URLs scoped to Deploy
   Previews and Branch deploys.
3. Deploy. `https://<site>/proxy/ping` answering 400 (unsigned request)
   shows the function is up; after step 4,
   `https://<store>.myshopify.com/apps/repairs/ping` answers
   `{ "ok": true, "installed": true }`.

### 4. Shopify (config and extensions)

```shell
npm run config:link     # shopify app config link → pick the existing ShopCare app
```

In `shopify.app.toml` set `application_url`, `[auth].redirect_urls`
(`https://<site>/auth/callback`) and `[app_proxy].url` (`https://<site>/proxy`)
to the Netlify site, then:

```shell
npm run deploy          # shopify app deploy: scopes, webhooks, App Proxy, extensions
```

Open ShopCare in each store's admin and approve the changed permissions (the
scopes now include `write_customers`; see
[`docs/GOING-LIVE.md`](docs/GOING-LIVE.md)).

## More docs

- [`docs/PORTING.md`](docs/PORTING.md): Rails → TS checklist, Netlify cost notes, notifications design
- [`docs/BACKGROUND-WORK.md`](docs/BACKGROUND-WORK.md): background and scheduled functions, webhook ack pattern
- [`docs/ROADMAP.md`](docs/ROADMAP.md), [`docs/GOING-LIVE.md`](docs/GOING-LIVE.md), [`docs/MERCHANT-ADMIN-SPEC.md`](docs/MERCHANT-ADMIN-SPEC.md): product docs carried over from Rails

## Gotchas

- **react-router is pinned at 7.18.2** (see `.github/dependabot.yml`): 7.18.3+
  rejects action POSTs under `shopify app dev`'s tunnel. Lift the pin when the
  template adopts `allowedActionOrigins`.
- **Embedded navigation:** use `Link` from react-router, `redirect` from
  `authenticate.admin`, and `useSubmit`. Never use a plain `<a>` or
  react-router's `redirect`.
- **Webhooks** are app-specific (in the toml), not registered in `afterAuth`.
  Webhooks triggered by the CLI have no `admin` client.
- **"nbf" claim timestamp check failed**: your machine's clock is off.
