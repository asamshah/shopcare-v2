import type { ActionFunctionArgs } from "react-router";
import { quoteDecline } from "../services/storefront/quote-routes.server";

/** POST /apps/repairs/quotes/:token/decline (see quote-routes.server.ts). */
export const action = (args: ActionFunctionArgs) => quoteDecline(args);
