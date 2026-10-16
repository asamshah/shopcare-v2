-- Postage slips: the customer posts their item to the workshop.
-- Ticket statuses are plain strings (no constraint): "awaiting_item" and
-- "received" need no migration of their own.
ALTER TABLE "repair_tickets" ADD COLUMN "item_received_at" TIMESTAMP(3),
ADD COLUMN "postage_slip_key" TEXT,
ADD COLUMN "postage_slip_digest" TEXT,
ADD COLUMN "postage_emails_sent" INTEGER NOT NULL DEFAULT 0;
