import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { TradeInProgramForm } from "../components/trade-in-program-form";
import { plainNumber } from "../lib/money";
import { createTradeInProgram, DEFAULT_GRADES } from "../models/trade-in-program.server";
import { saveOr422 } from "../services/admin/catalog-forms.server";
import { requireAdmin, requireTradeIn } from "../services/admin/context.server";
import { redirectWithFlash } from "../services/admin/flash.server";
import { readForm } from "../services/admin/form.server";
import { gradeRows, nextProgramPosition, type ProgramValues, readProgram } from "../services/admin/trade-in-programs.server";

const defaults = async (shopId: number): Promise<ProgramValues> => ({
  name: "Trade-in",
  creditMode: "fixed",
  maxAgeMonths: "",
  instructions: "Post your item to us within 14 days. We'll email your credit once we've checked it.",
  active: true,
  grades: DEFAULT_GRADES.map((g) => ({
    key: g.key,
    label: g.label,
    description: g.description ?? "",
    value: plainNumber(g.value),
  })),
  eligibilityMode: "all",
  eligibilityValue: "",
  position: String(await nextProgramPosition(shopId)),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireTradeIn(shop);
  const values = await defaults(shop.id);
  return { values, rows: gradeRows(values.grades) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireTradeIn(shop);
  const { values, input } = readProgram(await readForm(request), await defaults(shop.id));
  return saveOr422(
    values,
    async () => {
      await createTradeInProgram({ shopId: shop.id, ...input });
      return redirectWithFlash("/app/trade_in_programs", { notice: "Trade-in program created." });
    },
    { rows: gradeRows(values.grades.filter((g) => g.label)) },
  );
};

export default function NewTradeInProgram() {
  const loaded = useLoaderData<typeof loader>();
  const failed = useActionData<typeof action>();
  return (
    <s-page heading="New trade-in program">
      <s-link slot="breadcrumb-actions" href="/app/trade_in_programs">
        Trade-in programs
      </s-link>
      <TradeInProgramForm values={failed?.values ?? loaded.values} rows={failed?.rows ?? loaded.rows} errors={failed?.errors} />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
