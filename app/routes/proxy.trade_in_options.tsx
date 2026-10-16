import { tradeInParked } from "../services/storefront/trade-ins.server";
import { storefrontRoute } from "../services/storefront/deps.server";

/**
 * GET /apps/repairs/trade_in_options → /proxy/trade_in_options. Trade-in is
 * parked for V2 (per-shop flag `settings.trade_in_enabled`, off by default):
 * see app/services/storefront/trade-ins.server.ts.
 */
export const loader = storefrontRoute({}, (ctx) => tradeInParked(ctx));
