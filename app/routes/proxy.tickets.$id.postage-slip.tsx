import type { LoaderFunctionArgs } from "react-router";
import { postageSlipDownload } from "../services/storefront/postage-slip-route.server";

/** GET /apps/repairs/tickets/:id/postage-slip: the postage slip PDF (see postage-slip-route.server.ts). */
export const loader = (args: LoaderFunctionArgs) => postageSlipDownload(args);
