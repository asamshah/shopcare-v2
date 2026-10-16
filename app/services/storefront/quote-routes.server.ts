/**
 * The quote review page's two routes (Rails Proxy::QuotesController):
 *   GET  /apps/repairs/quotes/:token          the quote: lines, total, expiry,
 *                                             Pay now (the invoice) and Decline
 *   POST /apps/repairs/quotes/:token/decline  decline, with an optional reason
 * Paying is accepting, so there's no accept step. Works for guests: the
 * random token in the link is the only authorisation (constant-time compare,
 * within its own shop); a cancelled or superseded quote's token is gone, so
 * its link finds nothing. Rendered as Liquid so the page sits in the theme.
 */
import { findByDecisionToken, isDecisionOverdue } from "../../models/quotation.server";
import { proxyPathPrefix } from "../../models/shop.server";
import { formParams, storefrontRoute, textParam, type StorefrontContext } from "./deps.server";
import { loadQuoteForPage, renderQuotePage, type QuoteForPage } from "./quote-page.server";

const TOKEN = /^[A-Za-z0-9_-]+$/;

type Args = { request: Request; params: Record<string, string | undefined> };

async function findQuote(ctx: StorefrontContext, token: string): Promise<QuoteForPage | null> {
  if (!TOKEN.test(token)) return null;
  const quotation = await findByDecisionToken(ctx.shopRecord.id, token);
  return quotation ? loadQuoteForPage(quotation.id) : null;
}

function page(
  ctx: StorefrontContext,
  token: string,
  quotation: QuoteForPage | null,
  error: string | null = null,
) {
  const html = renderQuotePage({
    quotation,
    error,
    actionBase: `${proxyPathPrefix(ctx.shopRecord)}/quotes/${token}`,
    choice: ctx.params.get("choice"),
  });
  return ctx.liquid(html, { status: quotation ? 200 : 404 });
}

export function quoteShow(args: Args) {
  const token = args.params.token ?? "";
  return storefrontRoute({}, async (ctx) => {
    let quotation = await findQuote(ctx, token);
    if (!quotation) return page(ctx, token, null);
    if (isDecisionOverdue(quotation, ctx.deps.now())) {
      await ctx.deps.expireQuote({
        shopId: ctx.shopRecord.id,
        quotationId: quotation.id,
        ...(await decisionOptions(ctx)),
      });
      quotation = await loadQuoteForPage(quotation.id);
    }
    return page(ctx, token, quotation);
  })(args);
}

export function quoteDecline(args: Args) {
  const token = args.params.token ?? "";
  return storefrontRoute({}, async (ctx) => {
    const quotation = await findQuote(ctx, token);
    if (!quotation) return page(ctx, token, null);
    const form = await formParams(ctx);
    const result = await ctx.deps.declineQuote({
      shopId: ctx.shopRecord.id,
      quotationId: quotation.id,
      reason: textParam(form, "reason"),
      by: "customer",
      ...(await decisionOptions(ctx)),
    });
    return page(ctx, token, await loadQuoteForPage(quotation.id), result.ok ? null : result.error);
  })(args);
}

/** The proxy's Shopify client, notifications and job queue for the decision services. */
async function decisionOptions(ctx: StorefrontContext) {
  return {
    client: await ctx.deps.adminClient(ctx),
    notifyDeps: ctx.deps.notifications(),
    enqueue: ctx.deps.enqueue,
  };
}
