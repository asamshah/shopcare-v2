/**
 * Fires a ShopCare Shopify Flow trigger for the shop (`flowTriggerReceive`).
 * Ported from Rails Notifications::FlowClient; an optional integration in v2.
 *
 * The Admin GraphQL client is passed in (`admin.graphql` from
 * `authenticate.admin` / `unauthenticated.admin`, or test/support FakeGraphql).
 */
import { DeliveryError } from "./delivery-error.server";
import type { FlowFields } from "./events.server";

/** Same shape as the library's `admin.graphql`. */
export type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

export const FLOW_TRIGGER_MUTATION = `#graphql
  mutation ShopCareFlowTrigger($handle: String!, $payload: JSON!) {
    flowTriggerReceive(handle: $handle, payload: $payload) {
      userErrors { field message }
    }
  }
`;

/** "77" or "gid://shopify/Customer/77" → 77 (Flow's customer_id is numeric). */
export function numericCustomerId(id: string | number): number {
  const match = String(id).match(/(\d+)\s*$/);
  if (!match)
    throw new DeliveryError(`Invalid Shopify customer id ${id}`, false);
  return Number(match[1]);
}

/** The trigger payload: `customer_id` first when the trigger has a customer reference. */
export function flowPayload(
  customerId: string | number | null | undefined,
  fields: FlowFields,
): Record<string, string | number> {
  return customerId !== null && customerId !== undefined && customerId !== ""
    ? { customer_id: numericCustomerId(customerId), ...fields }
    : { ...fields };
}

export class FlowClient {
  constructor(private readonly graphql: AdminGraphql) {}

  /** `customerId`: null for a trigger without a customer reference (staff alerts). */
  async trigger(
    handle: string,
    {
      customerId,
      fields,
    }: { customerId: string | number | null | undefined; fields: FlowFields },
  ): Promise<void> {
    const response = await this.graphql(FLOW_TRIGGER_MUTATION, {
      variables: { handle, payload: flowPayload(customerId, fields) },
    });
    if (!response.ok) {
      throw new DeliveryError(
        `Flow trigger ${handle}: HTTP ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    const body = (await response.json()) as {
      data?: {
        flowTriggerReceive?: { userErrors?: { message: string }[] };
      };
      errors?: { message: string }[];
    };
    const errors = [
      ...(body.errors ?? []),
      ...(body.data?.flowTriggerReceive?.userErrors ?? []),
    ];
    if (errors.length) {
      // Rails retried these too: a trigger can be briefly unknown just after a deploy.
      throw new DeliveryError(errors.map((e) => e.message).join(", "));
    }
  }
}
