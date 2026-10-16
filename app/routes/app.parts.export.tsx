import type { LoaderFunctionArgs } from "react-router";
import { requireAdmin, requireParts } from "../services/admin/context.server";
import { csvResponse, today } from "../services/admin/parts.server";
import { exportParts } from "../services/parts/csv-export.server";

// GET /app/parts/export — every part and variant with today's stock, in the import's columns.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  return csvResponse(await exportParts(shop.id), `workshop-inventory-${today()}.csv`);
};
