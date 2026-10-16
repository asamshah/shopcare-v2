-- Fixed-window counters for App Proxy throttling
-- (app/lib/proxy-throttling.server.ts, postgresThrottleStore).
-- Pending: add the model below to prisma/schema.prisma and generate a
-- migration at integration; this file is the reviewed SQL it should match.
--
-- model ProxyThrottle {
--   /// "<endpoint>/<shop domain>/ip:<ip>" or "<endpoint>/<shop domain>/shop"
--   key         String   @id
--   windowStart DateTime @map("window_start") @db.Timestamptz(6)
--   count       Int
--
--   @@index([windowStart])
--   @@map("proxy_throttles")
-- }
--
-- Rows are one per endpoint + shop + IP and are reset in place each window;
-- prune old ones daily (ThrottleStore.prune, e.g. from a scheduled function):
--   DELETE FROM proxy_throttles WHERE window_start < now() - interval '1 day';

CREATE TABLE "proxy_throttles" (
    "key" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "proxy_throttles_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "proxy_throttles_window_start_idx" ON "proxy_throttles"("window_start");
