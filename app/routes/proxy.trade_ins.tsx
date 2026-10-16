import { tradeInParked } from "../services/storefront/trade-ins.server";
import { storefrontRoute } from "../services/storefront/deps.server";

/**
 * POST /apps/repairs/trade_ins → /proxy/trade_ins. Trade-in is parked for V2:
 * see app/services/storefront/trade-ins.server.ts.
 */
export const action = storefrontRoute({}, (ctx) => tradeInParked(ctx));
