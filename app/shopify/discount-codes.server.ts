/**
 * Single-use, fixed-amount discount codes (Care credit, trade-in credit).
 * Restricted to one customer when we know them, and optionally to a set of
 * products. Ported from Rails `Shopify::DiscountCodes`.
 */
import { randomInt } from "node:crypto";
import { buildGid } from "../lib/gid";
import {
  adminGraphql,
  assertNoUserErrors,
  moneyString,
  type AdminGraphqlClient,
  type UserError,
} from "./graphql.server";

export const DISCOUNT_CODE_CREATE_MUTATION = `#graphql
  mutation DiscountCodeBasicCreate($input: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $input) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`;

export interface DiscountCodeOptions {
  title: string;
  code: string;
  amount: number | string;
  /** Numeric id or GID; the code then works only for this customer. */
  customerId?: string | null;
  /** Numeric ids or GIDs; the code then applies only to these products. */
  productIds?: string[] | null;
  expiresAt?: Date | null;
  /** Defaults to now. */
  startsAt?: Date;
}

/** DiscountCodeOptions → GraphQL DiscountCodeBasicInput. */
export function discountCodeInput(
  options: DiscountCodeOptions,
): Record<string, unknown> {
  const productIds = options.productIds?.filter(Boolean) ?? [];
  return {
    title: options.title,
    code: options.code,
    startsAt: (options.startsAt ?? new Date()).toISOString(),
    ...(options.expiresAt ? { endsAt: options.expiresAt.toISOString() } : {}),
    usageLimit: 1,
    appliesOncePerCustomer: true,
    context: options.customerId
      ? { customers: { add: [buildGid("Customer", options.customerId)] } }
      : { all: "ALL" },
    customerGets: {
      value: {
        discountAmount: {
          amount: moneyString(options.amount),
          appliesOnEachItem: false,
        },
      },
      items:
        productIds.length > 0
          ? {
              products: {
                productsToAdd: productIds.map((id) => buildGid("Product", id)),
              },
            }
          : { all: true },
    },
    combinesWith: {
      productDiscounts: false,
      orderDiscounts: false,
      shippingDiscounts: true,
    },
  };
}

/** Creates the code. Returns the discount's GID. */
export async function createDiscountCode(
  client: AdminGraphqlClient,
  options: DiscountCodeOptions,
): Promise<string> {
  const data = await adminGraphql<{
    discountCodeBasicCreate: {
      codeDiscountNode: { id: string } | null;
      userErrors: UserError[];
    };
  }>(client, DISCOUNT_CODE_CREATE_MUTATION, {
    input: discountCodeInput(options),
  });
  const payload = data.discountCodeBasicCreate;
  assertNoUserErrors("discountCodeBasicCreate", payload);
  if (!payload.codeDiscountNode)
    throw new Error("discountCodeBasicCreate returned no discount");
  return payload.codeDiscountNode.id;
}

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** "TRADEIN" → "TRADEIN-7K2Q9XZA" (8 random letters/digits). */
export function generateDiscountCode(prefix: string): string {
  let suffix = "";
  for (let i = 0; i < 8; i++)
    suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${prefix}-${suffix}`;
}
