import type { LoaderFunctionArgs } from "react-router";
import { requireAdmin, requireParts } from "../services/admin/context.server";
import { csvResponse, parseIsoDate } from "../services/admin/parts.server";
import { exportStockUsed } from "../services/parts/csv-export.server";

const iso = (d: Date) => d.toISOString().slice(0, 10);

// GET /app/parts/stock_used?from=&to= — stock movements between two dates (default: the last 30 days).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  const params = new URL(request.url).searchParams;
  let to = parseIsoDate(params.get("to")) ?? parseIsoDate(iso(new Date()))!;
  let from = parseIsoDate(params.get("from")) ?? new Date(to.getTime() - 30 * 86_400_000);
  if (from > to) [from, to] = [to, from];
  return csvResponse(
    await exportStockUsed(shop.id, { from, to }),
    `workshop-inventory-used-${iso(from)}-to-${iso(to)}.csv`,
  );
};
