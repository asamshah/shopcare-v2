import type { LoaderFunctionArgs } from "react-router";
import { requireAdmin, requireParts } from "../services/admin/context.server";
import { csvResponse } from "../services/admin/parts.server";
import { templateCsv } from "../services/parts/csv-import.server";

// GET /app/parts/imports/template — the import's columns with example rows.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  return csvResponse(templateCsv(), "workshop-inventory-template.csv");
};
