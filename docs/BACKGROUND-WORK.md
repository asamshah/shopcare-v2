# Background work on Netlify

ShopCare has no always-on worker (no Solid Queue, no Sidekiq). Work outside a
request runs in Netlify Functions:

| Need | Use | Limit | Example |
|---|---|---|---|
| Answer a request or webhook | the React Router SSR function | 60 s (keep webhooks < 5 s) | `app/routes/webhooks.orders.paid.tsx` |
| Long or slow work (Admin API pages, Flow / Klaviyo deliveries, imports) | **Background Function** `netlify/functions/jobs-background.mts` | 15 min, 256 KB request, retried twice on error (after 1 min and 2 min); then the jobs sweep | `enqueue("example", …)` |
| Daily or periodic work | **Scheduled Function** | 30 s, published deploy only, cron in UTC | in use: `jobs-sweep.mts` (every 5 min), `daily-prune.mts`, `daily-care-offers.mts`, `daily-expire-quotes.mts`, `hourly-notification-sweep.mts` (copy any of them) |

Docs: [background functions](https://docs.netlify.com/build/functions/background-functions/),
[scheduled functions](https://docs.netlify.com/build/functions/scheduled-functions/).

## The pieces

```
route / webhook / scheduled fn
        │  enqueue(job, payload)                app/lib/background.server.ts
        ▼
INSERT INTO jobs (name, payload, …)              saved first: can't be lost
        │
        ▼
POST /.netlify/functions/jobs-background         { jobId }, signed: x-shopcare-signature
        │  202 straight away
        ▼
runStoredJob(id): claim → runJob → delete        app/lib/background.server.ts
        │
        ▼
app/jobs/<job>.server.ts                         plain async function, no Netlify imports

jobs-sweep.mts (every 5 min) → sweepJobs()       sends again: failed runs past their backoff,
                                                 dispatches that never arrived, crashed runs
```

- **Jobs** are plain functions registered in `app/jobs/registry.server.ts`.
  They don't import Netlify, so tests and `shopify app dev` run them in-process.
- **`enqueue()`** saves the job in the `jobs` table, then picks a mode from
  `BACKGROUND_DISPATCH`: `netlify` (signed POST of the job's id to the
  background function; a failed POST is reported, not thrown, and the sweep
  sends it), `inline` (run in-process without awaiting; the default off
  Netlify; no sweep, so a failed job stays `pending`), `sync` (run and
  awaited, not saved; tests). It throws only if the job can't be saved.
- **Saved jobs:** a run claims its row (`pending` → `running`), so a
  duplicate dispatch does nothing, and deletes it on success. A failure
  goes back to `pending` with a backoff (1, 2, 10, 30, 120 minutes), and
  after 6 attempts (Netlify's own retries count) the row is `failed` and
  the error is reported. A `running` row older than 20 minutes crashed or
  timed out and is run again. Rows older than 7 days, failed ones included,
  are pruned daily (webhook jobs hold customer data); shop/redact deletes a
  shop's rows. To look into a failure: `SELECT name, attempts, last_error
  FROM jobs WHERE status = 'failed'`.
- **Errors** (`app/lib/errors.server.ts`): a job that gives up, a failed
  dispatch or sweep, and loader/action errors are logged and, with
  `SENTRY_DSN` set, sent to Sentry (tags only: job name and id, shop domain,
  route; never payloads).
- **Security:** the function URL is public. Requests carry an HMAC over
  `timestamp.body` (key derived from `APP_ENCRYPTION_KEY`), and the function
  drops anything unsigned, unknown or older than 5 minutes.

## Rules for jobs

1. **Idempotent.** Netlify retries failures, and Shopify redelivers webhooks.
   Key every side effect on something stable: the webhook id, a
   `notification_deliveries.idempotency_key`, or a unique index
   (`processed_refunds` already does this in Rails).
2. **Pass ids, not records.** Re-read state from Postgres inside the job.
3. **Throw to retry, return to give up.** Throw on transient failures (429,
   5xx, timeouts). Catch, log and return on permanent ones (bad input, a shop
   that has uninstalled), so retries aren't wasted.
4. **Stay under 15 minutes.** For work that can grow (an order backfill), process a
   page and `enqueue` the next one with a cursor.
5. **Scheduled functions only enqueue.** They get 30 s, so they find what's
   due and hand it to the background function.

## Webhooks: ack fast

Shopify wants a 2xx within 5 seconds and retries otherwise, eventually removing
the subscription. Every webhook route:

1. `authenticate.webhook(request)` checks the HMAC (401 if it's wrong).
2. Does at most one quick step inline: a single indexed DB write, such as
   deleting sessions on `app/uninstalled`.
3. Hands everything else to the `webhook` job with `ackAndEnqueue(request)`
   (`app/lib/webhooks.server.ts`) and returns 200. The job (payload
   included) is saved before the 200, so an acked delivery can't be lost,
   and only its id goes to the background function, whose requests can't be
   over **256 KB** (a big order's payload can be). If it can't be saved, the
   route fails and Shopify delivers again.

Handlers per topic live in `app/jobs/webhook.server.ts`. Until a handler is
ported, the job logs `no handler ported yet` as a warning; check the logs
before going live.

Rails equivalents: `OrdersPaidJob`, `RefundsCreateJob`, `CustomersRedactJob`,
`ShopRedactJob`, `CustomersDataRequestJob`, `AppUninstalledJob`.

## Database connections

Each function instance opens its own Prisma connection, so use Neon's
**pooled** URL for `DATABASE_URL` in production. `DIRECT_URL` (unpooled) is
used only by `prisma migrate`.
