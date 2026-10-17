-- CreateTable
CREATE TABLE "jobs" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "shop_domain" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "run_after" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jobs_status_run_after_idx" ON "jobs"("status", "run_after");

-- CreateIndex
CREATE INDEX "jobs_shop_domain_idx" ON "jobs"("shop_domain");

-- CreateIndex
CREATE INDEX "jobs_created_at_idx" ON "jobs"("created_at");
