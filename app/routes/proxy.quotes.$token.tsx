import type { LoaderFunctionArgs } from "react-router";
import { quoteShow } from "../services/storefront/quote-routes.server";

/** GET /apps/repairs/quotes/:token: the quote review page (see quote-routes.server.ts). */
export const loader = (args: LoaderFunctionArgs) => quoteShow(args);
