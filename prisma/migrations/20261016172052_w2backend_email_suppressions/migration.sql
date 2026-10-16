-- CreateTable
CREATE TABLE "email_suppressions" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER,
    "scope_key" TEXT NOT NULL,
    "email_digest" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "index_email_suppressions_on_email_digest" ON "email_suppressions"("email_digest");

-- CreateIndex
CREATE UNIQUE INDEX "index_email_suppressions_on_scope_digest_kind" ON "email_suppressions"("scope_key", "email_digest", "kind");

-- AddForeignKey
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
