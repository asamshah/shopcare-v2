-- CreateTable
CREATE TABLE "shops" (
    "id" SERIAL NOT NULL,
    "shopify_domain" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "installed_at" TIMESTAMP(3),
    "uninstalled_at" TIMESTAMP(3),
    "setup_completed_at" TIMESTAMP(3),
    "klaviyo_api_key_ciphertext" TEXT,
    "customer_signing_key_ciphertext" TEXT,
    "webhook_secret_ciphertext" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "care_credits" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "cover_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "shopify_discount_id" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "care_credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "care_plans" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "shopify_product_id" TEXT,
    "shopify_variant_id" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "term_months" INTEGER NOT NULL DEFAULT 24,
    "excess" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "exclusions" TEXT,
    "perks" JSONB NOT NULL DEFAULT '{}',
    "offer_window_days" INTEGER NOT NULL DEFAULT 30,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "product_group_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "care_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "covers" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "item_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'warranty',
    "warranty_policy_id" INTEGER,
    "care_plan_id" INTEGER,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "terms" JSONB NOT NULL DEFAULT '{}',
    "usage" JSONB NOT NULL DEFAULT '{}',
    "shopify_order_id" TEXT,
    "shopify_line_item_id" TEXT,
    "price_paid" DECIMAL(10,2),
    "line_unit_index" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "covers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "shopify_customer_id" TEXT,
    "customer_email" TEXT,
    "customer_name" TEXT,
    "product_id" TEXT,
    "variant_id" TEXT,
    "product_title" TEXT,
    "variant_title" TEXT,
    "sku" TEXT,
    "order_id" TEXT,
    "order_name" TEXT,
    "order_line_id" TEXT,
    "unit_index" INTEGER NOT NULL DEFAULT 0,
    "purchased_at" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'order',
    "status" TEXT NOT NULL DEFAULT 'active',
    "properties" JSONB NOT NULL DEFAULT '{}',
    "eligible_care_plan_ids" JSONB NOT NULL DEFAULT '[]',
    "unit_price" DECIMAL(10,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "event" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "idempotency_key" TEXT,
    "provider_message_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_imports" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "csv_data" TEXT NOT NULL,
    "applied_at" TIMESTAMP(3),
    "summary" JSONB NOT NULL DEFAULT '{}',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "part_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_variants" (
    "id" SERIAL NOT NULL,
    "part_id" INTEGER NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "sku" TEXT,
    "on_hand" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "part_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parts" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "pack_size" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "cost_per_unit" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "reorder_level" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "reorder_quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "option_names" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_refunds" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "refund_id" TEXT NOT NULL,
    "order_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processed_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_groups" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "rule" TEXT NOT NULL DEFAULT 'all',
    "collections" JSONB NOT NULL DEFAULT '[]',
    "tags" JSONB NOT NULL DEFAULT '[]',
    "product_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_line_items" (
    "id" SERIAL NOT NULL,
    "quotation_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'repair',
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "cover_discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "shopify_product_id" TEXT,
    "shopify_variant_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotation_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" SERIAL NOT NULL,
    "repair_ticket_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT,
    "subtotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "shopify_draft_order_id" TEXT,
    "shopify_draft_order_url" TEXT,
    "shopify_order_id" TEXT,
    "sent_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "cover_id" INTEGER,
    "cover_discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "cover_discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "cover_excess" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "decision_token_digest" TEXT,
    "decision_token_ciphertext" TEXT,
    "decision_expires_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "decided_by" TEXT,
    "decision_reason" TEXT,
    "revised_from_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registrations" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "item_id" INTEGER NOT NULL,
    "retailer" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "proof_key" TEXT,
    "proof_filename" TEXT,
    "proof_content_type" TEXT,
    "proof_byte_size" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_services" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "shopify_product_id" TEXT,
    "shopify_variant_id" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "labour_minutes" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repair_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_tickets" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "shopify_customer_id" TEXT,
    "customer_email" TEXT,
    "customer_name" TEXT,
    "customer_phone" TEXT,
    "customer_address" JSONB NOT NULL DEFAULT '{}',
    "product_id" TEXT,
    "variant_id" TEXT,
    "product_title" TEXT,
    "variant_title" TEXT,
    "order_number" TEXT,
    "order_date" TIMESTAMP(3),
    "in_warranty" BOOLEAN NOT NULL DEFAULT false,
    "no_order_history" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "assigned_to" TEXT,
    "item_id" INTEGER,
    "cover_id" INTEGER,
    "costs" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repair_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_components" (
    "id" SERIAL NOT NULL,
    "repair_service_id" INTEGER NOT NULL,
    "part_id" INTEGER NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "match" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "part_variant_id" INTEGER NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "reason" TEXT NOT NULL,
    "repair_ticket_id" INTEGER,
    "unit_cost" DECIMAL(12,4),
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_activities" (
    "id" SERIAL NOT NULL,
    "repair_ticket_id" INTEGER NOT NULL,
    "activity_type" TEXT NOT NULL,
    "body" TEXT,
    "author" TEXT NOT NULL DEFAULT 'staff',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_images" (
    "id" SERIAL NOT NULL,
    "repair_ticket_id" INTEGER NOT NULL,
    "url" TEXT,
    "storage_key" TEXT,
    "filename" TEXT,
    "content_type" TEXT,
    "byte_size" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_parts" (
    "id" SERIAL NOT NULL,
    "repair_ticket_id" INTEGER NOT NULL,
    "part_id" INTEGER NOT NULL,
    "part_variant_id" INTEGER,
    "repair_service_id" INTEGER,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "unit_cost" DECIMAL(12,4),
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_in_programs" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "eligibility" JSONB NOT NULL DEFAULT '{"mode": "all"}',
    "credit_mode" TEXT NOT NULL DEFAULT 'fixed',
    "grades" JSONB NOT NULL DEFAULT '[]',
    "max_age_months" INTEGER,
    "instructions" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trade_in_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_ins" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "trade_in_program_id" INTEGER,
    "item_id" INTEGER,
    "shopify_customer_id" TEXT,
    "customer_email" TEXT,
    "customer_name" TEXT,
    "product_title" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL DEFAULT 'form',
    "status" TEXT NOT NULL DEFAULT 'requested',
    "declared_grade" TEXT,
    "quoted_credit" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "final_grade" TEXT,
    "final_credit" DECIMAL(10,2),
    "currency" TEXT,
    "shopify_order_id" TEXT,
    "order_name" TEXT,
    "credit_method" TEXT,
    "credit_reference" TEXT,
    "credited_at" TIMESTAMP(3),
    "staff_note" TEXT,
    "photos" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trade_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warranty_policies" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "months" INTEGER NOT NULL DEFAULT 12,
    "outcome" TEXT NOT NULL DEFAULT 'free',
    "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 100,
    "covered_faults" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "product_group_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warranty_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "index_shops_on_shopify_domain" ON "shops"("shopify_domain");

-- CreateIndex
CREATE UNIQUE INDEX "index_care_credits_on_cover_id" ON "care_credits"("cover_id");

-- CreateIndex
CREATE UNIQUE INDEX "index_care_credits_on_shop_id_and_code" ON "care_credits"("shop_id", "code");

-- CreateIndex
CREATE INDEX "index_care_plans_on_product_group_id" ON "care_plans"("product_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "index_care_plans_on_shop_id_and_shopify_variant_id" ON "care_plans"("shop_id", "shopify_variant_id");

-- CreateIndex
CREATE INDEX "index_covers_on_care_plan_id" ON "covers"("care_plan_id");

-- CreateIndex
CREATE INDEX "index_covers_on_item_id" ON "covers"("item_id");

-- CreateIndex
CREATE INDEX "index_covers_on_warranty_policy_id" ON "covers"("warranty_policy_id");

-- CreateIndex
CREATE INDEX "index_items_on_shop_id_and_created_at" ON "items"("shop_id", "created_at");

-- CreateIndex
CREATE INDEX "index_items_on_shop_id_and_shopify_customer_id" ON "items"("shop_id", "shopify_customer_id");

-- CreateIndex
CREATE INDEX "index_notification_deliveries_on_shop_id_and_created_at" ON "notification_deliveries"("shop_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "index_notification_deliveries_on_idempotency" ON "notification_deliveries"("shop_id", "channel", "idempotency_key");

-- CreateIndex
CREATE INDEX "index_part_imports_on_shop_id" ON "part_imports"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "index_part_variants_on_part_id_and_options" ON "part_variants"("part_id", "options");

-- CreateIndex
CREATE INDEX "index_parts_on_shop_id" ON "parts"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "index_processed_refunds_on_shop_id_and_refund_id" ON "processed_refunds"("shop_id", "refund_id");

-- CreateIndex
CREATE INDEX "index_quotation_line_items_on_quotation_id" ON "quotation_line_items"("quotation_id");

-- CreateIndex
CREATE UNIQUE INDEX "index_quotations_on_decision_token_digest" ON "quotations"("decision_token_digest");

-- CreateIndex
CREATE INDEX "index_quotations_on_cover_id" ON "quotations"("cover_id");

-- CreateIndex
CREATE INDEX "index_quotations_on_repair_ticket_id_and_created_at" ON "quotations"("repair_ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "index_quotations_on_shopify_draft_order_id" ON "quotations"("shopify_draft_order_id");

-- CreateIndex
CREATE INDEX "index_quotations_on_shopify_order_id" ON "quotations"("shopify_order_id");

-- CreateIndex
CREATE INDEX "index_quotations_on_status_and_decision_expires_at" ON "quotations"("status", "decision_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "index_registrations_on_item_id" ON "registrations"("item_id");

-- CreateIndex
CREATE INDEX "index_registrations_on_shop_id_and_status" ON "registrations"("shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "index_repair_services_on_shop_id_and_shopify_variant_id" ON "repair_services"("shop_id", "shopify_variant_id");

-- CreateIndex
CREATE INDEX "index_repair_tickets_on_cover_id" ON "repair_tickets"("cover_id");

-- CreateIndex
CREATE INDEX "index_repair_tickets_on_item_id" ON "repair_tickets"("item_id");

-- CreateIndex
CREATE INDEX "index_repair_tickets_on_shop_id_and_created_at" ON "repair_tickets"("shop_id", "created_at");

-- CreateIndex
CREATE INDEX "index_repair_tickets_on_shop_id_and_shopify_customer_id" ON "repair_tickets"("shop_id", "shopify_customer_id");

-- CreateIndex
CREATE INDEX "index_repair_tickets_on_shop_id_and_status" ON "repair_tickets"("shop_id", "status");

-- CreateIndex
CREATE INDEX "index_service_components_on_part_id" ON "service_components"("part_id");

-- CreateIndex
CREATE INDEX "index_service_components_on_repair_service_id" ON "service_components"("repair_service_id");

-- CreateIndex
CREATE INDEX "index_stock_movements_on_part_variant_id" ON "stock_movements"("part_variant_id");

-- CreateIndex
CREATE INDEX "index_stock_movements_on_repair_ticket_id" ON "stock_movements"("repair_ticket_id");

-- CreateIndex
CREATE INDEX "index_stock_movements_on_shop_id_and_created_at" ON "stock_movements"("shop_id", "created_at");

-- CreateIndex
CREATE INDEX "index_ticket_activities_on_repair_ticket_id_and_created_at" ON "ticket_activities"("repair_ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "index_ticket_images_on_repair_ticket_id" ON "ticket_images"("repair_ticket_id");

-- CreateIndex
CREATE INDEX "index_ticket_parts_on_part_id" ON "ticket_parts"("part_id");

-- CreateIndex
CREATE INDEX "index_ticket_parts_on_part_variant_id" ON "ticket_parts"("part_variant_id");

-- CreateIndex
CREATE INDEX "index_ticket_parts_on_repair_service_id" ON "ticket_parts"("repair_service_id");

-- CreateIndex
CREATE INDEX "index_ticket_parts_on_repair_ticket_id" ON "ticket_parts"("repair_ticket_id");

-- CreateIndex
CREATE INDEX "index_trade_in_programs_on_shop_id_and_position" ON "trade_in_programs"("shop_id", "position");

-- CreateIndex
CREATE INDEX "index_trade_ins_on_item_id" ON "trade_ins"("item_id");

-- CreateIndex
CREATE INDEX "index_trade_ins_on_shop_id_and_shopify_customer_id" ON "trade_ins"("shop_id", "shopify_customer_id");

-- CreateIndex
CREATE INDEX "index_trade_ins_on_shop_id_and_status_and_created_at" ON "trade_ins"("shop_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "index_trade_ins_on_trade_in_program_id" ON "trade_ins"("trade_in_program_id");

-- CreateIndex
CREATE INDEX "index_warranty_policies_on_product_group_id" ON "warranty_policies"("product_group_id");

-- CreateIndex
CREATE INDEX "index_warranty_policies_on_shop_id" ON "warranty_policies"("shop_id");

-- AddForeignKey
ALTER TABLE "care_credits" ADD CONSTRAINT "care_credits_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_credits" ADD CONSTRAINT "care_credits_cover_id_fkey" FOREIGN KEY ("cover_id") REFERENCES "covers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_plans" ADD CONSTRAINT "care_plans_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_plans" ADD CONSTRAINT "care_plans_product_group_id_fkey" FOREIGN KEY ("product_group_id") REFERENCES "product_groups"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "covers" ADD CONSTRAINT "covers_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "covers" ADD CONSTRAINT "covers_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "covers" ADD CONSTRAINT "covers_warranty_policy_id_fkey" FOREIGN KEY ("warranty_policy_id") REFERENCES "warranty_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "covers" ADD CONSTRAINT "covers_care_plan_id_fkey" FOREIGN KEY ("care_plan_id") REFERENCES "care_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_imports" ADD CONSTRAINT "part_imports_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_variants" ADD CONSTRAINT "part_variants_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts" ADD CONSTRAINT "parts_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processed_refunds" ADD CONSTRAINT "processed_refunds_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_groups" ADD CONSTRAINT "product_groups_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_line_items" ADD CONSTRAINT "quotation_line_items_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_cover_id_fkey" FOREIGN KEY ("cover_id") REFERENCES "covers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_revised_from_id_fkey" FOREIGN KEY ("revised_from_id") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_services" ADD CONSTRAINT "repair_services_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_cover_id_fkey" FOREIGN KEY ("cover_id") REFERENCES "covers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_components" ADD CONSTRAINT "service_components_repair_service_id_fkey" FOREIGN KEY ("repair_service_id") REFERENCES "repair_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_components" ADD CONSTRAINT "service_components_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_part_variant_id_fkey" FOREIGN KEY ("part_variant_id") REFERENCES "part_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_activities" ADD CONSTRAINT "ticket_activities_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_images" ADD CONSTRAINT "ticket_images_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_parts" ADD CONSTRAINT "ticket_parts_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_parts" ADD CONSTRAINT "ticket_parts_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "parts"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_parts" ADD CONSTRAINT "ticket_parts_part_variant_id_fkey" FOREIGN KEY ("part_variant_id") REFERENCES "part_variants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_parts" ADD CONSTRAINT "ticket_parts_repair_service_id_fkey" FOREIGN KEY ("repair_service_id") REFERENCES "repair_services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_in_programs" ADD CONSTRAINT "trade_in_programs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_ins" ADD CONSTRAINT "trade_ins_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_ins" ADD CONSTRAINT "trade_ins_trade_in_program_id_fkey" FOREIGN KEY ("trade_in_program_id") REFERENCES "trade_in_programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_ins" ADD CONSTRAINT "trade_ins_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranty_policies" ADD CONSTRAINT "warranty_policies_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranty_policies" ADD CONSTRAINT "warranty_policies_product_group_id_fkey" FOREIGN KEY ("product_group_id") REFERENCES "product_groups"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written: indexes Prisma's schema language can't express (partial and
-- expression indexes), copied from the Rails db/schema.rb. Prisma doesn't
-- model them, so if a later `prisma migrate dev` generates DROP INDEX for any
-- of these, delete those lines from that migration.
-- ---------------------------------------------------------------------------

-- One Care cover per unit of a Care order line (Rails index_covers_on_care_line_unit).
CREATE UNIQUE INDEX "index_covers_on_care_line_unit"
  ON "covers" ("shop_id", "shopify_line_item_id", "line_unit_index")
  WHERE "shopify_line_item_id" IS NOT NULL;

-- One item per unit of an order line.
CREATE UNIQUE INDEX "index_items_on_shop_id_and_order_line_id_and_unit_index"
  ON "items" ("shop_id", "order_line_id", "unit_index")
  WHERE "order_line_id" IS NOT NULL;

-- At most one open trade-in per item (TradeIn OPEN_STATUSES).
CREATE UNIQUE INDEX "index_trade_ins_one_open_per_item"
  ON "trade_ins" ("item_id")
  WHERE "item_id" IS NOT NULL
    AND "status" IN ('requested', 'approved', 'received', 'crediting');

-- Product group names are unique per shop, case-insensitively.
CREATE UNIQUE INDEX "index_product_groups_on_shop_id_and_name"
  ON "product_groups" ("shop_id", lower("name"));
