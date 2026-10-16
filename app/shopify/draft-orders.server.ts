/**
 * The draft order behind a repair quote: create it, bring it up to date, have
 * Shopify email its invoice, complete it without payment (warranty / £0) and
 * delete it (a cancelled quote, so its invoice link stops working).
 *
 * Rails used REST (`POST/PUT/DELETE draft_orders…`, ported from the pilot's
 * middleware). These are the GraphQL equivalents:
 *   POST draft_orders                    → draftOrderCreate
 *   PUT draft_orders/:id                 → draftOrderUpdate (line items replace the old ones)
 *   POST draft_orders/:id/send_invoice   → draftOrderInvoiceSend
 *   PUT draft_orders/:id/complete?payment_pending=false → draftOrderComplete
 *     (no payment gateway: the order is marked as paid)
 *   DELETE draft_orders/:id              → draftOrderDelete
 *
 * Ids are returned numeric, as Rails stored them; any function taking an id
 * accepts a numeric id or a GID.
 */
import { buildGid, numericId } from "../lib/gid";
import {
  adminGraphql,
  assertNoUserErrors,
  moneyString,
  type AdminGraphqlClient,
  type UserError,
} from "./graphql.server";

const DRAFT_ORDER_FIELDS = `id name invoiceUrl status`;

export const DRAFT_ORDER_CREATE_MUTATION = `#graphql
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { ${DRAFT_ORDER_FIELDS} }
      userErrors { field message }
    }
  }
`;

export const DRAFT_ORDER_UPDATE_MUTATION = `#graphql
  mutation DraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder { ${DRAFT_ORDER_FIELDS} }
      userErrors { field message }
    }
  }
`;

export const DRAFT_ORDER_INVOICE_SEND_MUTATION = `#graphql
  mutation DraftOrderInvoiceSend($id: ID!, $email: EmailInput) {
    draftOrderInvoiceSend(id: $id, email: $email) {
      draftOrder { ${DRAFT_ORDER_FIELDS} }
      userErrors { field message }
    }
  }
`;

export const DRAFT_ORDER_COMPLETE_MUTATION = `#graphql
  mutation DraftOrderComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder { ${DRAFT_ORDER_FIELDS} order { id name } }
      userErrors { field message }
    }
  }
`;

export const DRAFT_ORDER_DELETE_MUTATION = `#graphql
  mutation DraftOrderDelete($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }
`;

/** A fixed or percentage discount on one line (REST `applied_discount`). */
export interface DraftOrderDiscount {
  description?: string;
  title?: string;
  valueType: "FIXED_AMOUNT" | "PERCENTAGE";
  /** The amount (FIXED_AMOUNT) or percentage (PERCENTAGE, 0–100). */
  value: number | string;
}

/**
 * One draft-order line: a real variant (`variantId`) or a custom line
 * (`title` + `price`). Prices are in the draft order's currency.
 */
export type DraftOrderLine =
  | {
      variantId: string;
      quantity: number;
      /**
       * The price to charge instead of the variant's catalogue price. Repair
       * quotes always send it (quoteDraftOrderAttributes in
       * app/services/repairs/quote-draft-order.server.ts), so the invoice
       * total matches the quote. Rails passed `price`, which REST silently
       * ignored on variant lines: a quote priced differently from the catalogue
       * produced an invoice for the catalogue price.
       */
      priceOverride?: number | string;
      appliedDiscount?: DraftOrderDiscount;
      customAttributes?: { key: string; value: string }[];
    }
  | {
      title: string;
      quantity: number;
      price: number | string;
      requiresShipping?: boolean;
      taxable?: boolean;
      sku?: string;
      appliedDiscount?: DraftOrderDiscount;
      customAttributes?: { key: string; value: string }[];
    };

export interface DraftOrderAttributes {
  lineItems: DraftOrderLine[];
  /** ISO 4217; custom-line prices and discounts are sent in this currency. */
  currencyCode: string;
  email?: string | null;
  /** REST took a comma-separated string; both forms are accepted. */
  tags?: string[] | string | null;
  note?: string | null;
  /** REST `note_attributes`. */
  customAttributes?: { key: string; value: string }[];
  useCustomerDefaultAddress?: boolean;
}

export interface DraftOrderRef {
  /** Numeric id, as stored on the quotation. */
  id: string;
  gid: string;
  name: string;
  invoiceUrl: string | null;
  status: string;
}

interface DraftOrderNode {
  id: string;
  name: string;
  invoiceUrl: string | null;
  status: string;
}

interface DraftOrderPayload {
  draftOrder: DraftOrderNode | null;
  userErrors: UserError[];
}

/** DraftOrderAttributes → GraphQL DraftOrderInput. */
export function draftOrderInput(
  attributes: DraftOrderAttributes,
): Record<string, unknown> {
  const currencyCode = attributes.currencyCode;
  const money = (amount: number | string) => ({
    amount: moneyString(amount),
    currencyCode,
  });
  const discount = (d: DraftOrderDiscount | undefined) =>
    d && {
      description: d.description,
      title: d.title,
      valueType: d.valueType,
      value: Number(d.value),
      ...(d.valueType === "FIXED_AMOUNT"
        ? { amountWithCurrency: money(d.value) }
        : {}),
    };

  const lineItems = attributes.lineItems.map((line) =>
    "variantId" in line
      ? compact({
          variantId: buildGid("ProductVariant", line.variantId),
          quantity: line.quantity,
          priceOverride:
            line.priceOverride === undefined
              ? undefined
              : money(line.priceOverride),
          appliedDiscount: discount(line.appliedDiscount),
          customAttributes: line.customAttributes,
        })
      : compact({
          title: line.title,
          quantity: line.quantity,
          originalUnitPriceWithCurrency: money(line.price),
          requiresShipping: line.requiresShipping,
          taxable: line.taxable,
          sku: line.sku,
          appliedDiscount: discount(line.appliedDiscount),
          customAttributes: line.customAttributes,
        }),
  );

  const tags =
    typeof attributes.tags === "string"
      ? attributes.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : attributes.tags;

  return compact({
    lineItems,
    email: attributes.email ?? undefined,
    tags: tags ?? undefined,
    note: attributes.note ?? undefined,
    customAttributes: attributes.customAttributes,
    useCustomerDefaultAddress: attributes.useCustomerDefaultAddress,
    presentmentCurrencyCode: currencyCode,
  });
}

export async function createDraftOrder(
  client: AdminGraphqlClient,
  attributes: DraftOrderAttributes,
): Promise<DraftOrderRef> {
  const data = await adminGraphql<{ draftOrderCreate: DraftOrderPayload }>(
    client,
    DRAFT_ORDER_CREATE_MUTATION,
    { input: draftOrderInput(attributes) },
  );
  return draftRef("draftOrderCreate", data.draftOrderCreate);
}

/** Replaces the draft order's details; the lines sent replace the old ones. */
export async function updateDraftOrder(
  client: AdminGraphqlClient,
  draftOrderId: string,
  attributes: DraftOrderAttributes,
): Promise<DraftOrderRef> {
  const data = await adminGraphql<{ draftOrderUpdate: DraftOrderPayload }>(
    client,
    DRAFT_ORDER_UPDATE_MUTATION,
    {
      id: buildGid("DraftOrder", draftOrderId),
      input: draftOrderInput(attributes),
    },
  );
  return draftRef("draftOrderUpdate", data.draftOrderUpdate);
}

/** Has Shopify email the customer the draft order's checkout link. */
export async function sendDraftOrderInvoice(
  client: AdminGraphqlClient,
  draftOrderId: string,
  email: { subject?: string | null; customMessage?: string | null } = {},
): Promise<DraftOrderRef> {
  const data = await adminGraphql<{ draftOrderInvoiceSend: DraftOrderPayload }>(
    client,
    DRAFT_ORDER_INVOICE_SEND_MUTATION,
    {
      id: buildGid("DraftOrder", draftOrderId),
      email: compact({
        subject: email.subject ?? undefined,
        customMessage: email.customMessage ?? undefined,
      }),
    },
  );
  return draftRef("draftOrderInvoiceSend", data.draftOrderInvoiceSend);
}

export interface CompletedDraftOrder extends DraftOrderRef {
  /** The numeric id of the order it became; null if Shopify hasn't made it yet. */
  orderId: string | null;
  orderName: string | null;
}

/** Converts the draft order into an order marked as paid. */
export async function completeDraftOrder(
  client: AdminGraphqlClient,
  draftOrderId: string,
): Promise<CompletedDraftOrder> {
  const data = await adminGraphql<{
    draftOrderComplete: {
      draftOrder:
        | (DraftOrderNode & { order: { id: string; name: string } | null })
        | null;
      userErrors: UserError[];
    };
  }>(client, DRAFT_ORDER_COMPLETE_MUTATION, {
    id: buildGid("DraftOrder", draftOrderId),
  });
  const payload = data.draftOrderComplete;
  const ref = draftRef("draftOrderComplete", payload);
  const order = payload.draftOrder?.order ?? null;
  return {
    ...ref,
    orderId: order ? numericId(order.id) : null,
    orderName: order?.name ?? null,
  };
}

/** Deletes the draft order. Returns its numeric id. */
export async function deleteDraftOrder(
  client: AdminGraphqlClient,
  draftOrderId: string,
): Promise<string> {
  const data = await adminGraphql<{
    draftOrderDelete: { deletedId: string | null; userErrors: UserError[] };
  }>(client, DRAFT_ORDER_DELETE_MUTATION, {
    input: { id: buildGid("DraftOrder", draftOrderId) },
  });
  assertNoUserErrors("draftOrderDelete", data.draftOrderDelete);
  return numericId(data.draftOrderDelete.deletedId ?? draftOrderId);
}

function draftRef(
  operation: string,
  payload: DraftOrderPayload,
): DraftOrderRef {
  assertNoUserErrors(operation, payload);
  const draft = payload.draftOrder;
  if (!draft) throw new Error(`${operation} returned no draft order`);
  return {
    id: numericId(draft.id),
    gid: draft.id,
    name: draft.name,
    invoiceUrl: draft.invoiceUrl,
    status: draft.status,
  };
}

/** Drops undefined values, so optional input fields aren't sent as null. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}
