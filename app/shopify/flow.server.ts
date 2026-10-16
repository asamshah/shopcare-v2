/**
 * Fires one of ShopCare's Shopify Flow triggers (extensions/shopcare-flow-*)
 * for the shop. Ported from Rails `Notifications::FlowClient`; in v2 Flow is
 * an optional integration (docs/PORTING.md → Notifications).
 */
import {
  adminGraphql,
  ShopifyUserError,
  type AdminGraphqlClient,
  type UserError,
} from "./graphql.server";

export const FLOW_TRIGGER_MUTATION = `#graphql
  mutation FlowTriggerReceive($handle: String!, $payload: JSON!) {
    flowTriggerReceive(handle: $handle, payload: $payload) {
      userErrors { field message }
    }
  }
`;

/**
 * `customerId`: null for a trigger without a customer reference (staff
 * alerts); otherwise sent as the numeric `customer_id` Flow expects.
 * Throws ShopifyUserError when Flow rejects it.
 */
export async function triggerFlow(
  client: AdminGraphqlClient,
  handle: string,
  options: { customerId?: string | null; fields: Record<string, unknown> },
): Promise<void> {
  const payload = options.customerId
    ? { customer_id: flowCustomerId(options.customerId), ...options.fields }
    : options.fields;
  const data = await adminGraphql<{
    flowTriggerReceive: { userErrors: UserError[] } | null;
  }>(client, FLOW_TRIGGER_MUTATION, { handle, payload });
  const errors = data.flowTriggerReceive?.userErrors ?? [];
  if (errors.length > 0)
    throw new ShopifyUserError("flowTriggerReceive", errors);
}

/**
 * Flow wants the customer id as a JSON number. Today's ids (13 digits) fit a
 * JS number exactly; one that doesn't is sent as a string rather than rounded.
 */
function flowCustomerId(customerId: string): number | string {
  const id = Number(customerId.split("/").pop());
  return Number.isSafeInteger(id) ? id : customerId;
}
