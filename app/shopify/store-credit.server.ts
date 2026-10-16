/**
 * Shopify store credit on a customer's account (trade-in credit paid as store
 * credit). Ported from the store-credit half of Rails `TradeIns::CreditIssuer`;
 * choosing between store credit and a discount code stays with the caller.
 */
import { buildGid } from "./gid.server";
import {
  adminGraphql,
  assertNoUserErrors,
  moneyString,
  type AdminGraphqlClient,
  type UserError,
} from "./graphql.server";

export const STORE_CREDIT_MUTATION = `#graphql
  mutation StoreCreditAccountCredit($id: ID!, $input: StoreCreditAccountCreditInput!) {
    storeCreditAccountCredit(id: $id, creditInput: $input) {
      storeCreditAccountTransaction { id }
      userErrors { field message }
    }
  }
`;

export interface StoreCreditOptions {
  /** Numeric id or GID. Crediting a customer uses (or opens) their account in this currency. */
  customerId: string;
  amount: number | string;
  currencyCode: string;
  expiresAt?: Date | null;
  /** Email the customer about the credit. Default true, as in Rails. */
  notify?: boolean;
}

/** Credits the customer. Returns the transaction's GID. */
export async function creditStoreCredit(
  client: AdminGraphqlClient,
  options: StoreCreditOptions,
): Promise<string> {
  const input = {
    creditAmount: {
      amount: moneyString(options.amount),
      currencyCode: options.currencyCode,
    },
    notify: options.notify ?? true,
    ...(options.expiresAt
      ? { expiresAt: options.expiresAt.toISOString() }
      : {}),
  };
  const data = await adminGraphql<{
    storeCreditAccountCredit: {
      storeCreditAccountTransaction: { id: string } | null;
      userErrors: UserError[];
    };
  }>(client, STORE_CREDIT_MUTATION, {
    id: buildGid("Customer", options.customerId),
    input,
  });
  const payload = data.storeCreditAccountCredit;
  assertNoUserErrors("storeCreditAccountCredit", payload);
  if (!payload.storeCreditAccountTransaction)
    throw new Error("storeCreditAccountCredit returned no transaction");
  return payload.storeCreditAccountTransaction.id;
}
