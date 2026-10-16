/**
 * Admin GraphQL stand-in for the draft-order calls quotes make (Rails
 * FakeDraftOrderApi): records each call as [kind, variables], answers with
 * draft order 999, can fail the invoice send, and knows the shop's name,
 * currency and the customer metafield calls the payment sync makes.
 */
import { FakeGraphql } from "./fake-graphql";

export type DraftCall = [kind: string, variables: Record<string, unknown>];

export class FakeDraftOrders {
  failInvoice = false;
  failDelete = false;
  draft = { id: "gid://shopify/DraftOrder/999", name: "#D1", invoiceUrl: "https://shop.test/invoice/abc", status: "OPEN" };

  readonly graphql: FakeGraphql;

  constructor() {
    this.graphql = new FakeGraphql({
      "draftOrderCreate(": () => ({ draftOrderCreate: { draftOrder: this.draft, userErrors: [] } }),
      "draftOrderUpdate(": () => ({ draftOrderUpdate: { draftOrder: this.draft, userErrors: [] } }),
      "draftOrderInvoiceSend(": () => {
        if (this.failInvoice) throw new Error("Shopify timed out");
        return { draftOrderInvoiceSend: { draftOrder: this.draft, userErrors: [] } };
      },
      "draftOrderComplete(": () => ({
        draftOrderComplete: {
          draftOrder: { ...this.draft, order: { id: "gid://shopify/Order/5001", name: "#5001" } },
          userErrors: [],
        },
      }),
      "draftOrderDelete(": () => {
        if (this.failDelete) throw new Error("Not found");
        return { draftOrderDelete: { deletedId: this.draft.id, userErrors: [] } };
      },
      "query ShopInfo": {
        shop: {
          name: "Test Shop",
          email: "owner@shop.test",
          contactEmail: "hello@shop.test",
          currencyCode: "GBP",
          myshopifyDomain: "x.myshopify.com",
        },
      },
      "metafield(namespace": { customer: { id: "gid://shopify/Customer/77", metafield: null } },
      "metafieldsSet(": { metafieldsSet: { metafields: [], userErrors: [] } },
    });
  }

  /** The client to pass as `client`. */
  get client() {
    return this.graphql;
  }

  /** ["create", "invoice", …] */
  get calls(): DraftCall[] {
    return this.graphql.calls.flatMap(({ query, variables }) => {
      const kind = [
        ["draftOrderCreate(", "create"],
        ["draftOrderUpdate(", "update"],
        ["draftOrderInvoiceSend(", "invoice"],
        ["draftOrderComplete(", "complete"],
        ["draftOrderDelete(", "delete"],
        ["metafieldsSet(", "metafield"],
      ].find(([fragment]) => query.includes(fragment))?.[1];
      return kind ? [[kind, variables] as DraftCall] : [];
    });
  }

  kinds(): string[] {
    return this.calls.map(([kind]) => kind);
  }
}
