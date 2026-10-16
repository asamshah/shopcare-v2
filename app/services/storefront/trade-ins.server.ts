/**
 * The storefront trade-in endpoints (Rails Proxy::TradeInsController). Trade-in
 * is parked for V2: a shop without `settings.trade_in_enabled` gets Rails'
 * "not available" answer (`require_trade_in`), and the theme extension ships
 * no trade-in blocks.
 *
 * Deferred with the V2 trade-in work (decided): with the flag on, Rails
 * answered from TradeIns::Quoter (options) and TradeIns::Submission (create).
 * The Quoter is ported (app/services/trade-ins/quoter.server.ts, used by the
 * staff workflow); Submission and these two endpoints are not, so they stay
 * parked even with the flag on rather than half-work.
 */
import { tradeInEnabled } from "../../models/shop.server";
import type { StorefrontContext } from "./deps.server";

export const TRADE_IN_UNAVAILABLE = "Trade-in isn't available.";

export function tradeInParked(ctx: StorefrontContext): Response {
  if (tradeInEnabled(ctx.shopRecord)) {
    console.error(`[proxy/trade-ins] ${ctx.shop}: trade_in_enabled is on, but trade-in isn't ported yet`);
  }
  return ctx.json(
    { ok: false, available: false, errors: [TRADE_IN_UNAVAILABLE] },
    { cache: "no-store", status: 404 },
  );
}
