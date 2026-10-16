import { ItemRecorder } from "../services/items/recorder.server";
import { OrderImporter } from "../services/items/order-importer.server";
import {
  INTAKE_ADDRESS_KEYS,
  INTAKE_FIELDS,
  submitIntake,
  type IntakeParams,
} from "../services/repairs/intake-submission.server";
import { formParams, storefrontRoute, textParam } from "../services/storefront/deps.server";
import { OwnedItemResolver } from "../services/storefront/owned-item-resolver.server";
import { ProductFactsLoader } from "../shopify/product-facts.server";

/**
 * POST /apps/repairs/intake → /proxy/intake (multipart: the form fields plus
 * `images[]`). Creates a repair ticket; a chosen item is re-verified server
 * side (owned-item resolver, or the guest's signed order token). 422 with
 * `errors` when it can't be filed. Port of Proxy::IntakeController.
 */
export const action = storefrontRoute({}, async (ctx) => {
  const shop = ctx.shopRecord;
  const form = await formParams(ctx);
  const params: IntakeParams = {};
  for (const field of INTAKE_FIELDS) params[field] = textParam(form, field);
  const address: Record<string, string | null> = {};
  for (const key of INTAKE_ADDRESS_KEYS) address[key] = textParam(form, `customer_address[${key}]`);
  params.customer_address = address;

  const customerId = await ctx.currentCustomerId();
  const importer = async () => {
    const client = await ctx.deps.adminClient(ctx);
    const recorder = new ItemRecorder(shop, {
      facts: new ProductFactsLoader(client, { shopKey: shop.shopifyDomain }),
    });
    return new OrderImporter(shop, client, recorder);
  };
  const result = await submitIntake(shop, params, {
    customerId,
    images: [...form.getAll("images[]"), ...form.getAll("images")],
    itemResolver: customerId ? new OwnedItemResolver(shop, customerId, importer) : null,
    storage: ctx.deps.storage(),
    notifications: ctx.deps.notifications(),
    enqueue: ctx.deps.enqueue,
    now: ctx.deps.now(),
  });

  return result.ok
    ? ctx.json({ ok: true, ticket_id: result.ticket.id }, { cache: "no-store" })
    : ctx.json({ ok: false, errors: result.errors }, { cache: "no-store", status: 422 });
});
