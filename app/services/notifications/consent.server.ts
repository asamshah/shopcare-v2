/**
 * Email marketing consent, read from Shopify at send time (see "Marketing
 * consent" in docs/PORTING.md). Only SUBSCRIBED counts; guests have no consent
 * record, so they never get marketing email. The Shopify read is
 * `fetchEmailMarketingConsent` in app/shopify/customers.server.ts; a failed
 * read throws, so the notification job retries rather than guessing.
 */
import { fetchEmailMarketingConsent } from "../../shopify/customers.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import type { DeliveryRecipient } from "./store.server";

export type HasEmailMarketingConsent = (
  recipient: DeliveryRecipient,
) => Promise<boolean>;

/** The checker backed by the Admin API. */
export function shopifyMarketingConsent(
  client: AdminGraphqlClient,
): HasEmailMarketingConsent {
  return async ({ customerId, email }) => {
    if (!customerId) return false;
    const consent = await fetchEmailMarketingConsent(
      client,
      String(customerId),
    );
    if (!consent?.subscribed) return false;
    // Consent belongs to an address: don't use it for a different one.
    return (
      !email ||
      !consent.email ||
      consent.email.toLowerCase() === email.toLowerCase()
    );
  };
}
