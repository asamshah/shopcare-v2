/**
 * Customer reads and writes:
 *
 * - The `repairs.requested_products` JSON metafield the storefront reads to
 *   show repair status (Rails `AdminApi#update_repair_status`). Rails used REST
 *   `GET/POST customers/:id/metafields`; this reads `customer.metafield` and
 *   writes with `metafieldsSet`.
 */
import { buildGid } from "../lib/gid";
import {
  adminGraphql,
  assertNoUserErrors,
  type AdminGraphqlClient,
  type UserError,
} from "./graphql.server";

export const CUSTOMER_METAFIELD_QUERY = `#graphql
  query CustomerMetafield($id: ID!, $namespace: String!, $key: String!) {
    customer(id: $id) {
      id
      metafield(namespace: $namespace, key: $key) { value }
    }
  }
`;

export const METAFIELDS_SET_MUTATION = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

export const REPAIR_STATUS_NAMESPACE = "repairs";
export const REPAIR_STATUS_KEY = "requested_products";

export type JsonObject = Record<string, unknown>;

/** A customer's JSON metafield as an object; {} if missing or not an object. */
export async function getCustomerJsonMetafield(
  client: AdminGraphqlClient,
  customerId: string,
  namespace: string,
  key: string,
): Promise<JsonObject> {
  const data = await adminGraphql<{
    customer: { id: string; metafield: { value: string } | null } | null;
  }>(client, CUSTOMER_METAFIELD_QUERY, {
    id: buildGid("Customer", customerId),
    namespace,
    key,
  });
  const raw = data.customer?.metafield?.value;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

export async function setCustomerJsonMetafield(
  client: AdminGraphqlClient,
  customerId: string,
  namespace: string,
  key: string,
  value: unknown,
): Promise<void> {
  const data = await adminGraphql<{
    metafieldsSet: { userErrors: UserError[] };
  }>(client, METAFIELDS_SET_MUTATION, {
    metafields: [
      {
        ownerId: buildGid("Customer", customerId),
        namespace,
        key,
        type: "json",
        value: JSON.stringify(value),
      },
    ],
  });
  assertNoUserErrors("metafieldsSet", data.metafieldsSet);
}

/**
 * Sets the storefront's repair status for one product key (e.g. "10_20" →
 * "paid") in the customer's `repairs.requested_products` metafield, keeping
 * the other entries. Returns the object written.
 */
export async function updateRepairStatus(
  client: AdminGraphqlClient,
  customerId: string,
  productKey: string,
  status: string,
): Promise<JsonObject> {
  const existing = await getCustomerJsonMetafield(
    client,
    customerId,
    REPAIR_STATUS_NAMESPACE,
    REPAIR_STATUS_KEY,
  );
  const updated = { ...existing, [productKey]: status };
  await setCustomerJsonMetafield(
    client,
    customerId,
    REPAIR_STATUS_NAMESPACE,
    REPAIR_STATUS_KEY,
    updated,
  );
  return updated;
}
