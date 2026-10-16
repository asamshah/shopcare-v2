/**
 * Fires one of ShopCare's Shopify Flow triggers (extensions/shopcare-flow-*)
 * for the shop. Ported from Rails `Notifications::FlowClient`; in v2 Flow is
 * an optional integration (docs/PORTING.md → Notifications). The notification
 * job calls this through app/services/notifications/flow-client.server.ts,
 * which turns failures into DeliveryErrors.
 */
import {
  adminGraphql,
  ShopifyUserError,
  type AdminGraphqlClient,
  type RetryOptions,
  type UserError,
} from "./graphql.server";

export const FLOW_TRIGGER_MUTATION = `#graphql
  mutation ShopCareFlowTrigger($handle: String!, $payload: JSON!) {
    flowTriggerReceive(handle: $handle, payload: $payload) {
      userErrors { field message }
    }
  }
`;

export type FlowFields = Record<string, unknown>;

/** A customer id Flow can't take (not a Shopify customer id or GID). */
export class InvalidFlowCustomerIdError extends Error {
  constructor(id: string) {
    super(`Invalid Shopify customer id ${id}`);
    this.name = "InvalidFlowCustomerIdError";
  }
}

/**
 * "77" or "gid://shopify/Customer/77" → 77. ShopCare keeps customer ids as
 * strings everywhere; this is the one place one becomes a JSON number, because
 * a Flow trigger's customer reference must be numeric. An id beyond a JS
 * number's exact range is sent as its digit string rather than rounded.
 */
export function flowCustomerId(customerId: string): number | string {
  const match = String(customerId).match(/(\d+)\s*$/);
  if (!match) throw new InvalidFlowCustomerIdError(customerId);
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : match[1];
}

/** The trigger payload: `customer_id` first when the trigger has a customer reference. */
export function flowPayload(
  customerId: string | null | undefined,
  fields: FlowFields,
): Record<string, unknown> {
  return customerId
    ? { customer_id: flowCustomerId(customerId), ...fields }
    : { ...fields };
}

/**
 * `customerId`: null for a trigger without a customer reference (staff
 * alerts). Throws ShopifyUserError when Flow rejects it, ShopifyGraphqlError
 * for GraphQL errors.
 */
export async function triggerFlow(
  client: AdminGraphqlClient,
  handle: string,
  options: { customerId?: string | null; fields: FlowFields },
  retry?: RetryOptions,
): Promise<void> {
  const data = await adminGraphql<{
    flowTriggerReceive: { userErrors: UserError[] } | null;
  }>(
    client,
    FLOW_TRIGGER_MUTATION,
    { handle, payload: flowPayload(options.customerId, options.fields) },
    retry,
  );
  const errors = data.flowTriggerReceive?.userErrors ?? [];
  if (errors.length > 0)
    throw new ShopifyUserError("flowTriggerReceive", errors);
}
