-- All emails are sent by Shopify (draft-order invoice, Order confirmation
-- snippet, Shipping confirmation); ShopCare's own email sending (Resend) is
-- removed, with what only it used:
--   email_suppressions                       unsubscribes / bounces / complaints
--   notification_deliveries.provider_message_id  the email provider's message id
--   repair_tickets.postage_emails_sent       "Send your item to us" email count
-- Existing "email" / "staff_email" delivery rows are history only: deleted.

-- DropForeignKey
ALTER TABLE "email_suppressions" DROP CONSTRAINT "email_suppressions_shop_id_fkey";

-- DropTable
DROP TABLE "email_suppressions";

-- AlterTable
ALTER TABLE "notification_deliveries" DROP COLUMN "provider_message_id";

-- AlterTable
ALTER TABLE "repair_tickets" DROP COLUMN "postage_emails_sent";

-- Old email deliveries
DELETE FROM "notification_deliveries" WHERE "channel" IN ('email', 'staff_email');
