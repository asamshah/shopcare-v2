import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import { requireAdmin } from "../services/admin/context.server";
import { redirectWithFlash } from "../services/admin/flash.server";
import { bool, field, has, parse, readForm, zInt, zOptionalId, zText } from "../services/admin/form.server";
import { completeSetup, recordPartsChoice, setupServices, setupWarranty } from "../services/admin/setup.server";

// POST /app/setup — the first-run setup's shortcuts (Rails SetupController).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await requireAdmin(request);
  const form = await readForm(request);
  const intent = parse(z.enum(["services", "warranty", "parts", "complete"]), field(form, "intent"));

  if (intent === "services") {
    const input = parse(z.object({ collectionId: zText(100), collectionTitle: zText(255) }), {
      collectionId: field(form, "collection_id"),
      collectionTitle: field(form, "collection_title"),
    });
    return redirectWithFlash("/app/tickets?setup_step=2", await setupServices(shop, admin, input));
  }
  if (intent === "warranty") {
    const input = parse(z.object({ months: zInt, productGroupId: zOptionalId }), {
      months: field(form, "months"),
      productGroupId: field(form, "product_group_id"),
    });
    return redirectWithFlash("/app/tickets?setup_step=3", await setupWarranty(shop, input));
  }
  if (intent === "parts") {
    // Step 3's "Next": remember the workshop inventory choice, then the optional step 4.
    await recordPartsChoice(shop, bool(form, "parts_enabled"));
    return redirectWithFlash("/app/tickets?setup_step=4", {});
  }
  const flash = await completeSetup(shop, {
    skipped: has(form, "skipped"),
    partsEnabled: has(form, "parts_enabled") ? bool(form, "parts_enabled") : null,
  });
  return redirectWithFlash("/app/tickets", flash);
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
