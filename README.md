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
  routes/            React Router routes: app.* (admin), proxy.* (App Proxy), webhooks.*, files.$
  models/            one module per Rails model: validations, enums, business rules (plain functions over Prisma rows)
  shopify/           Admin API (GraphQL) calls: draft orders, discounts, store credit, orders, products, shop
  lib/               infrastructure: encryption, storage, background dispatch, webhooks, http caching, row locks
  services/          domain services (email.server.ts so far; Rails services are ported here)
  jobs/              background job handlers + registry
  shopify.server.ts  @shopify/shopify-app-react-router setup (Prisma session storage)
  db.server.ts       Prisma client
netlify/functions/   jobs-background.mts (Background Function), daily-example.mts (Scheduled)
prisma/              schema + migrations (Postgres; every Rails table, see docs/PORTING.md#schema-notes)
extensions/          theme app extension + Flow triggers (copied unchanged from Rails)
parked/              Flow trigger not yet shipped (trade-in status)
test/unit/           pure tests
test/integration/    tests against a real Postgres
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
npm run test:unit           # no database needed
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

CI (`.github/workflows/ci.yml`) runs install, `prisma generate`,
`prisma migrate deploy` against a Postgres service container, then typecheck,
lint, tests and the Netlify build.

## Deploy

### Netlify (the app server)

The build uses Netlify's official React Router adapter,
[`@netlify/vite-plugin-react-router`](https://docs.netlify.com/frameworks/react-router/)
(in `vite.config.ts`). It wraps the server build in a Netlify Function, so SSR,
loaders and actions run in Netlify Functions (Node.js). `netlify.toml` sets the
build (`npm run build:netlify`: `prisma generate`, `prisma migrate deploy`,
`react-router build`), publish dir `build/client`, and bundles Prisma's engine
with the functions.

1. Create a Neon project (or enable Netlify DB, which provisions Neon). Copy
   the **pooled** connection string to `DATABASE_URL` and the **direct** one to
   `DIRECT_URL`.
2. Netlify site → Environment variables: everything in `.env.example`.
   `SHOPIFY_APP_URL` = the site URL. Set `BACKGROUND_DISPATCH=netlify`. Use a
   separate database (Neon branch) for Deploy Preview and Branch deploy
   contexts, because the build runs migrations.
3. Push to the production branch. Netlify builds and deploys.

### Shopify (config and extensions)

Set `application_url`, `[auth].redirect_urls` and `[app_proxy].url` in
`shopify.app.toml` to the Netlify URL, then `npm run deploy`. This pushes
scopes, webhook subscriptions, the App Proxy and the extensions.

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
