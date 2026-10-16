/**
 * Customer reads and writes:
 *
 * - The `repairs.requested_products` JSON metafield the storefront reads to
 *   show repair status (Rails `AdminApi#update_repair_status`). Rails used REST
 *   `GET/POST customers/:id/metafields`; this reads `customer.metafield` and
 *   writes with `metafieldsSet`.
 * - Customer tags: the `shopcare-care-offer-eligible` segment tag
 *   (app/services/care/care-offer-tags.server.ts).
 */
import { buildGid, numericId } from "../lib/gid";
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

// --- Customer tags (the "Add Care" offer's segment tag) --------------------------
// tagsAdd / tagsRemove take a Customer id; writing customer tags uses the
// write_customers scope ShopCare already has, and listing tagged customers
// read access (implied by it).
// https://shopify.dev/docs/api/admin-graphql/latest/mutations/tagsAdd
// https://shopify.dev/docs/api/admin-graphql/latest/mutations/tagsRemove

export const CUSTOMERS_WITH_TAG_QUERY = `#graphql
  query CustomersWithTag($query: String!, $after: String) {
    customers(first: 250, after: $after, query: $query) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const TAGS_ADD_MUTATION = `#graphql
  mutation CustomerTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

export const TAGS_REMOVE_MUTATION = `#graphql
  mutation CustomerTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

/** Numeric ids of every customer with `tag`. */
export async function customerIdsWithTag(client: AdminGraphqlClient, tag: string): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  do {
    const data: {
      customers: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } = await adminGraphql(client, CUSTOMERS_WITH_TAG_QUERY, { query: `tag:'${tag}'`, after });
    ids.push(...data.customers.nodes.map((node) => numericId(node.id)));
    after = data.customers.pageInfo.hasNextPage ? data.customers.pageInfo.endCursor : null;
  } while (after);
  return ids;
}

export async function addCustomerTag(client: AdminGraphqlClient, customerId: string, tag: string): Promise<void> {
  const data = await adminGraphql<{ tagsAdd: { userErrors: UserError[] } }>(client, TAGS_ADD_MUTATION, {
    id: buildGid("Customer", customerId),
    tags: [tag],
  });
  assertNoUserErrors("tagsAdd", data.tagsAdd);
}

export async function removeCustomerTag(client: AdminGraphqlClient, customerId: string, tag: string): Promise<void> {
  const data = await adminGraphql<{ tagsRemove: { userErrors: UserError[] } }>(client, TAGS_REMOVE_MUTATION, {
    id: buildGid("Customer", customerId),
    tags: [tag],
  });
  assertNoUserErrors("tagsRemove", data.tagsRemove);
}
