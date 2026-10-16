import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { TradeInProgramForm } from "../components/trade-in-program-form";
import { updateTradeInProgram } from "../models/trade-in-program.server";
import { saveOr422 } from "../services/admin/catalog-forms.server";
import { orNotFound, parseId, requireAdmin, requireTradeIn } from "../services/admin/context.server";
import { redirectWithFlash } from "../services/admin/flash.server";
import { field, readForm } from "../services/admin/form.server";
import { gradeRows, programValues, readProgram } from "../services/admin/trade-in-programs.server";

async function findProgram(shopId: number, id: string | undefined) {
  return orNotFound(await prisma.tradeInProgram.findFirst({ where: { id: parseId(id), shopId } }));
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireTradeIn(shop);
  const program = await findProgram(shop.id, params.id);
  const values = programValues(program);
  return { title: program.name, values, rows: gradeRows(values.grades) };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireTradeIn(shop);
  const program = await findProgram(shop.id, params.id);
  const form = await readForm(request);
  if (field(form, "intent") === "delete") {
    if ((await prisma.tradeIn.count({ where: { tradeInProgramId: program.id } })) > 0) {
      await prisma.tradeInProgram.update({ where: { id: program.id }, data: { active: false } });
      return redirectWithFlash("/app/trade_in_programs", {
        notice: "This program has trade-ins, so it's been switched off rather than deleted.",
      });
    }
    await prisma.tradeInProgram.delete({ where: { id: program.id } });
    return redirectWithFlash("/app/trade_in_programs", { notice: "Trade-in program deleted." });
  }
  const { values, input } = readProgram(form, programValues(program));
  return saveOr422(
    values,
    async () => {
      await updateTradeInProgram(program.id, input);
      return redirectWithFlash("/app/trade_in_programs", { notice: "Trade-in program saved." });
    },
    { rows: gradeRows(values.grades.filter((g) => g.label)) },
  );
};

export default function EditTradeInProgram() {
  const loaded = useLoaderData<typeof loader>();
  const failed = useActionData<typeof action>();
  return (
    <s-page heading={loaded.title}>
      <s-link slot="breadcrumb-actions" href="/app/trade_in_programs">
        Trade-in programs
      </s-link>
      <TradeInProgramForm values={failed?.values ?? loaded.values} rows={failed?.rows ?? loaded.rows} errors={failed?.errors} />
      <s-section heading="Delete program">
        <s-stack direction="block" gap="small-200">
          <s-paragraph color="subdued">A program with trade-ins is switched off instead.</s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="delete" />
            <s-button tone="critical" type="submit">
              Delete program
            </s-button>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
