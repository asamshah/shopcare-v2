/**
 * Email marketing consent, read from Shopify at send time (see "Marketing
 * consent" in docs/PORTING.md). Only SUBSCRIBED counts; guests have no consent
 * record, so they never get marketing email.
 */
import type { AdminGraphql } from "./flow-client.server";
import type { DeliveryRecipient } from "./store.server";

export type HasEmailMarketingConsent = (
  recipient: DeliveryRecipient,
) => Promise<boolean>;

// TODO(integration): confirm `defaultEmailAddress.marketingState` against the
// 2026-10 Admin schema (it replaced the deprecated `emailMarketingConsent`).
export const CUSTOMER_CONSENT_QUERY = `#graphql
  query ShopCareMarketingConsent($id: ID!) {
    customer(id: $id) {
      defaultEmailAddress { emailAddress marketingState }
    }
  }
`;

function customerGid(id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/Customer/${id}`;
}

/** The checker backed by the Admin API. */
export function shopifyMarketingConsent(
  graphql: AdminGraphql,
): HasEmailMarketingConsent {
  return async ({ customerId, email }) => {
    if (!customerId) return false;
    const response = await graphql(CUSTOMER_CONSENT_QUERY, {
      variables: { id: customerGid(String(customerId)) },
    });
    const body = (await response.json()) as {
      data?: {
        customer?: {
          defaultEmailAddress?: {
            emailAddress?: string | null;
            marketingState?: string | null;
          } | null;
        } | null;
      };
    };
    const address = body.data?.customer?.defaultEmailAddress;
    if (!address || address.marketingState !== "SUBSCRIBED") return false;
    // Consent belongs to an address: don't use it for a different one.
    return (
      !email ||
      !address.emailAddress ||
      address.emailAddress.toLowerCase() === email.toLowerCase()
    );
  };
}
