import type { LoaderFunctionArgs } from "react-router";
import { parseId, requireAdmin } from "../services/admin/context.server";
import { findTicket } from "../services/admin/tickets.server";
import {
  ensurePostageSlip,
  MissingWorkshopAddressError,
  postageSlipResponse,
} from "../services/repairs/postage-slip.server";

// GET /app/tickets/:id/postage_slip — the ticket's postage slip PDF (fetched by DownloadButton).
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const ticket = await findTicket(shop, parseId(params.id));
  try {
    return postageSlipResponse(await ensurePostageSlip(shop, ticket.id), "attachment");
  } catch (error) {
    if (error instanceof MissingWorkshopAddressError)
      return new Response(error.message, { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    throw error;
  }
};
