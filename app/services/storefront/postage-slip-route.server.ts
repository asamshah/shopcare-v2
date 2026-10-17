/**
 * GET /apps/repairs/tickets/:id/postage-slip → the ticket's postage slip PDF
 * (repairs/postage-slip.server.ts), for the customer to print.
 *
 * Who gets it: anyone holding a valid signed link (the one in Shopify's order
 * confirmation, valid POSTAGE_LINK_DAYS, so guests can download it; or the Repair
 * status block's, valid a day), else the logged-in customer who owns the
 * ticket. Everyone else sees "not found", whether or not the ticket exists.
 * Only while the ticket awaits its item. Private and never cached.
 */
import { liquidText } from "../../lib/http.server";
import { completeWorkshopAddress } from "../../models/shop.server";
import {
  ensurePostageSlip,
  postageSlipResponse,
  verifyPostageSlipLink,
} from "../repairs/postage-slip.server";
import prisma from "../../db.server";
import { storefrontRoute, type StorefrontContext } from "./deps.server";

export const POSTAGE_SLIP_LIMITS = { name: "postage_slip", perIp: 30, perShop: 1200, periodSeconds: 60 };

type Args = { request: Request; params: Record<string, string | undefined> };

const NOT_FOUND = "We couldn't find that postage slip. Check the link in your email, or log in to see your repairs.";

function message(ctx: StorefrontContext, status: number, text: string) {
  return ctx.liquid(
    `<div class="page-width shopcare-postage-slip"><h1>Postage slip</h1><p>${liquidText(text)}</p></div>`,
    { status },
  );
}

export function postageSlipDownload(args: Args) {
  const raw = args.params.id ?? "";
  return storefrontRoute({ throttle: POSTAGE_SLIP_LIMITS }, async (ctx) => {
    const id = /^\d{1,10}$/.test(raw) ? Number(raw) : null;
    const ticket = id
      ? await prisma.repairTicket.findFirst({ where: { id, shopId: ctx.shopRecord.id } })
      : null;
    if (!ticket) return message(ctx, 404, NOT_FOUND);

    const link = verifyPostageSlipLink(ctx.shop, ticket.id, ctx.params, ctx.deps.now());
    if (link !== "valid") {
      const customerId = await ctx.currentCustomerId();
      const owner = Boolean(customerId && ticket.shopifyCustomerId && customerId === ticket.shopifyCustomerId);
      if (!owner) {
        return link === "expired"
          ? message(
              ctx,
              410,
              "This link has expired. Log in to your account to download the postage slip from your repairs, or contact us for a new link.",
            )
          : message(ctx, 404, NOT_FOUND);
      }
    }

    if (ticket.status !== "awaiting_item") {
      return message(
        ctx,
        410,
        ticket.itemReceivedAt
          ? "We've already received your item, so you don't need this postage slip any more."
          : "This repair doesn't need a postage slip at the moment.",
      );
    }
    if (!completeWorkshopAddress(ctx.shopRecord)) {
      return message(ctx, 409, "Your postage slip isn't ready yet. Please check back soon, or contact us.");
    }
    const file = await ensurePostageSlip(ctx.shopRecord, ticket.id, {
      storage: ctx.deps.storage(),
      now: ctx.deps.now(),
    });
    return postageSlipResponse(file, "inline");
  })(args);
}
