/**
 * The notification job's Flow channel: fires the trigger through
 * app/shopify/flow.server.ts (where the Shopify call lives) and turns failures
 * into DeliveryErrors. Ported from Rails Notifications::FlowClient; an
 * optional integration in v2.
 *
 * One attempt per job run: throttling, 5xx and network errors are retryable
 * DeliveryErrors, so the background job's own retry schedule handles them.
 */
import {
  InvalidFlowCustomerIdError,
  triggerFlow,
} from "../../shopify/flow.server";
import {
  errorSummary,
  ShopifyGraphqlError,
  ShopifyUserError,
  type AdminGraphqlClient,
} from "../../shopify/graphql.server";
import { DeliveryError } from "./delivery-error.server";
import type { FlowFields } from "./events.server";

export class FlowClient {
  constructor(private readonly client: AdminGraphqlClient) {}

  /** `customerId`: null for a trigger without a customer reference (staff alerts). */
  async trigger(
    handle: string,
    {
      customerId,
      fields,
    }: { customerId: string | null | undefined; fields: FlowFields },
  ): Promise<void> {
    try {
      await triggerFlow(
        this.client,
        handle,
        { customerId, fields },
        { maxAttempts: 1 },
      );
    } catch (error) {
      if (error instanceof InvalidFlowCustomerIdError)
        throw new DeliveryError(error.message, false);
      // Rails retried user errors too: a trigger can be briefly unknown just
      // after a deploy.
      if (
        error instanceof ShopifyUserError ||
        error instanceof ShopifyGraphqlError
      )
        throw new DeliveryError(error.message);
      throw new DeliveryError(
        `Flow trigger ${handle}: ${errorSummary(error)}`,
        true,
      );
    }
  }
}
