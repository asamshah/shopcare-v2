import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { markShopUninstalled } from "../services/gdpr/shop-redact.server";

/**
 * app/uninstalled: one quick write, so it's done inline. The shop is marked
 * uninstalled and its sessions deleted (jobs and notifications stop); its
 * data is erased by shop/redact ~48 h later (see
 * app/services/gdpr/shop-redact.server.ts). Repeat deliveries are no-ops.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.info(`Received ${topic} webhook for ${shop}`);
  await markShopUninstalled(shop);
  return new Response();
};
