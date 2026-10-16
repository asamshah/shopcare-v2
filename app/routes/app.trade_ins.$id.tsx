import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import prisma from "../db.server";
import { selectedIf } from "../components/attrs";
import { formatDate, statusLabel, truncate, tradeInTone } from "../lib/format";
import { formatMoney } from "../lib/format.server";
import { signedUrl } from "../lib/storage.server";
import { programGrades } from "../models/trade-in-program.server";
import { gradeLabel, type TradeInPhoto, tradeInCredit } from "../models/trade-in.server";
import { jsonArray } from "../models/validation.server";
import { orNotFound, parseId, requireAdmin, requireTradeIn } from "../services/admin/context.server";
import { type Flash, redirectWithFlash } from "../services/admin/flash.server";
import { field, parse, readForm, zDecimal, zText } from "../services/admin/form.server";
import {
  approveTradeIn,
  cancelTradeIn,
  creditTradeIn,
  receiveTradeIn,
  rejectTradeIn,
} from "../services/trade_ins/workflow.server";

async function findTradeIn(shopId: number, id: string | undefined) {
  return orNotFound(
    await prisma.tradeIn.findFirst({ where: { id: parseId(id), shopId }, include: { tradeInProgram: true } }),
  );
}

// GET /app/trade_ins/:id (Rails TradeInsController#show).
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireTradeIn(shop);
  const t = await findTradeIn(shop.id, params.id);
  const program = t.tradeInProgram;
  const credit = formatMoney(tradeInCredit(t), t.currency);
  return {
    t: {
      id: t.id,
      status: t.status,
      statusLabel: statusLabel(t.status),
      tone: tradeInTone(t.status),
      productTitle: t.productTitle,
      itemId: t.itemId,
      fromPdp: t.source === "pdp",
      orderName: t.orderName ?? "",
      customerName: t.customerName ?? "",
      customerEmail: t.customerEmail,
      declaredGrade: t.declaredGrade,
      declared: `Condition: ${gradeLabel(program, t.declaredGrade)} · quoted ${formatMoney(t.quotedCredit, t.currency)}`,
      description: t.description,
      staffNote: t.staffNote,
      receivedAs: `Received as ${gradeLabel(program, t.finalGrade)}.`,
      credit,
      credited:
        t.status === "credited" && t.creditedAt
          ? `${credit} credited on ${formatDate(t.creditedAt)} ${
              t.creditMethod === "store_credit" ? "as store credit" : `as discount code ${t.creditReference ?? ""}`
            }.`
          : null,
      photos: (jsonArray(t.photos) as unknown as TradeInPhoto[])
        .filter((p) => p && typeof p.key === "string")
        .map((p) => ({ key: p.key, src: signedUrl(p.key), alt: p.filename })),
    },
    program: program
      ? {
          name: program.name,
          instructions: program.instructions?.trim() ? truncate(program.instructions, 80) : null,
          grades: programGrades(program).map((g) => ({ key: g.key, label: g.label })),
        }
      : null,
  };
};

const INTENTS = ["approve", "reject", "cancel", "receive", "credit"] as const;

// Staff steps (Rails TradeInsController): workflow errors go back as an alert.
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireTradeIn(shop);
  const t = await findTradeIn(shop.id, params.id);
  const form = await readForm(request);
  const intent = parse(z.enum(INTENTS), field(form, "intent"));
  const step = { shopId: shop.id, tradeInId: t.id, note: parse(zText(1000), field(form, "note")) || null };
  const money = (record: { finalCredit: unknown; quotedCredit: unknown; currency: string | null }) =>
    formatMoney(tradeInCredit(record as never), record.currency);
  let flash: Flash;
  try {
    switch (intent) {
      case "approve":
        await approveTradeIn(step);
        flash = { notice: "Trade-in approved; the customer has been told how to send it." };
        break;
      case "reject":
        await rejectTradeIn(step);
        flash = { notice: "Trade-in rejected." };
        break;
      case "cancel":
        await cancelTradeIn(step);
        flash = { notice: "Trade-in cancelled." };
        break;
      case "receive": {
        // Receive and grade the item; credit straight away unless staff untick it.
        await receiveTradeIn({
          ...step,
          grade: parse(zText(100), field(form, "grade")),
          credit: parse(zDecimal, field(form, "credit")),
        });
        if (field(form, "credit_now") === "1") {
          const credited = await creditTradeIn({ shopId: shop.id, tradeInId: t.id });
          flash = { notice: `Item received and ${money(credited)} credited.` };
        } else {
          flash = { notice: "Item received. Issue the credit when you're ready." };
        }
        break;
      }
      case "credit": {
        const credited = await creditTradeIn({ shopId: shop.id, tradeInId: t.id });
        flash = { notice: `${money(credited)} credited.` };
        break;
      }
    }
  } catch (error) {
    flash = { alert: (error as Error).message };
  }
  return redirectWithFlash(`/app/trade_ins/${t.id}`, flash);
};

function Note({ label = "Note (optional)" }: { label?: string }) {
  return <s-text-field label={label} name="note"></s-text-field>;
}

export default function TradeIn() {
  const { t, program } = useLoaderData<typeof loader>();
  const open = t.status === "requested" || t.status === "approved";
  return (
    <s-page heading={`Trade-in #${t.id}`}>
      <s-link slot="breadcrumb-actions" href="/app/trade_ins">
        Trade-ins
      </s-link>
      <s-badge slot="accessory" tone={t.tone}>
        {t.statusLabel}
      </s-badge>
      <s-grid grid-template-columns="2fr 1fr" gap="base">
        <s-stack direction="block" gap="base">
          <s-section heading="What happens next">
            <s-stack direction="block" gap="base">
              {t.status === "requested" ? (
                <>
                  <s-paragraph>
                    Check the photos and description. Approving tells the customer how to send it
                    {program?.instructions ? ` (${program.instructions})` : ""}.
                  </s-paragraph>
                  <s-grid grid-template-columns="1fr 1fr" gap="base">
                    <Form method="post">
                      <input type="hidden" name="intent" value="approve" />
                      <s-stack direction="block" gap="small-200">
                        <Note />
                        <s-stack direction="inline">
                          <s-button variant="primary" type="submit">
                            Approve
                          </s-button>
                        </s-stack>
                      </s-stack>
                    </Form>
                    <Form method="post">
                      <input type="hidden" name="intent" value="reject" />
                      <s-stack direction="block" gap="small-200">
                        <Note label="Reason (optional)" />
                        <s-stack direction="inline">
                          <s-button tone="critical" type="submit">
                            Reject
                          </s-button>
                        </s-stack>
                      </s-stack>
                    </Form>
                  </s-grid>
                </>
              ) : null}

              {open && program ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="receive" />
                  <s-stack direction="block" gap="small-200">
                    <s-heading>Item arrived</s-heading>
                    <s-grid grid-template-columns="1fr 1fr" gap="small-200">
                      <s-select label="Condition you found" name="grade">
                        {program.grades.map((g) => (
                          <s-option key={g.key} value={g.key} {...selectedIf(g.key === t.declaredGrade)}>
                            {g.label}
                          </s-option>
                        ))}
                      </s-select>
                      <s-money-field
                        label="Credit (optional)"
                        name="credit"
                        min={0}
                        details="Leave blank to use the program's value for that condition."
                      ></s-money-field>
                    </s-grid>
                    <Note />
                    <input type="hidden" name="credit_now" value="0" />
                    <s-checkbox name="credit_now" value="1" label="Issue the credit now" checked></s-checkbox>
                    <s-stack direction="inline">
                      <s-button variant="primary" type="submit">
                        Mark received
                      </s-button>
                    </s-stack>
                  </s-stack>
                </Form>
              ) : null}

              {t.status === "received" ? (
                <>
                  <Form method="post">
                    <input type="hidden" name="intent" value="credit" />
                    <s-stack direction="inline" gap="small-200" align-items="center">
                      <s-text>{t.receivedAs}</s-text>
                      <s-button variant="primary" type="submit">
                        Issue {t.credit} credit
                      </s-button>
                    </s-stack>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="reject" />
                    <s-button tone="critical" variant="tertiary" type="submit">
                      Reject (return the item)
                    </s-button>
                  </Form>
                </>
              ) : null}

              {t.credited ? <s-paragraph>{t.credited}</s-paragraph> : null}
              {t.status === "rejected" || t.status === "cancelled" ? (
                <s-paragraph color="subdued">This trade-in is closed.</s-paragraph>
              ) : null}
              {open ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="cancel" />
                  <s-button variant="tertiary" type="submit">
                    Cancel trade-in
                  </s-button>
                </Form>
              ) : null}
            </s-stack>
          </s-section>

          <s-section heading="What the customer told us">
            <s-stack direction="block" gap="small-200">
              <s-text>{t.declared}</s-text>
              {t.description ? <s-paragraph>{t.description}</s-paragraph> : null}
              {t.photos.length ? (
                <s-grid grid-template-columns="1fr 1fr 1fr" gap="small-200">
                  {t.photos.map((p) => (
                    <s-image key={p.key} src={p.src} alt={p.alt} aspect-ratio="1/1" object-fit="cover" loading="lazy"></s-image>
                  ))}
                </s-grid>
              ) : null}
              {t.staffNote ? (
                <s-paragraph color="subdued">
                  {t.staffNote.split("\n").map((line, i) => (
                    <span key={i}>
                      {line}
                      <br />
                    </span>
                  ))}
                </s-paragraph>
              ) : null}
            </s-stack>
          </s-section>
        </s-stack>

        <s-stack direction="block" gap="base">
          <s-section heading="Item">
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">{t.productTitle}</s-text>
              {t.itemId ? (
                <s-link href={`/app/items/${t.itemId}`}>Item #{t.itemId} (bought from you)</s-link>
              ) : (
                <s-text color="subdued">Not bought from you, or not on record</s-text>
              )}
              {program ? <s-text color="subdued">Program: {program.name}</s-text> : null}
              {t.fromPdp ? <s-text color="subdued">Added with order {t.orderName}</s-text> : null}
            </s-stack>
          </s-section>
          <s-section heading="Customer">
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">{t.customerName}</s-text>
              {t.customerEmail ? <s-text>{t.customerEmail}</s-text> : null}
            </s-stack>
          </s-section>
        </s-stack>
      </s-grid>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
