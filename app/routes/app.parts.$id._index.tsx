import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import prisma from "../db.server";
import { capitalize, formatDateTime, movementTone, statusLabel } from "../lib/format";
import { decimal, formatMoney } from "../lib/format.server";
import { ArgumentError, generateVariants, partOptionNames, quantityLabel, varies } from "../models/part.server";
import { moveStock, variantLabel, variantLow } from "../models/part-variant.server";
import { RECENT_ORDER as MOVEMENTS_ORDER } from "../models/stock-movement.server";
import { ORDERED as SERVICES_ORDER } from "../models/repair-service.server";
import { orNotFound, parseId, requireAdmin, requireParts, STAFF } from "../services/admin/context.server";
import { type Flash, redirectWithFlash } from "../services/admin/flash.server";
import { field, nested, parse, readForm, zText } from "../services/admin/form.server";
import { quantity } from "../services/admin/parts.server";
import { shopCurrency } from "../services/admin/tickets.server";

const EXAMPLES: Record<string, string> = {
  model: "Commando, Vibram Gumlite",
  size: "UK 5, UK 6, UK 7, UK 8",
  colour: "Black, Brown",
};

async function findPart(shopId: number, id: string | undefined) {
  return orNotFound(
    await prisma.part.findFirst({
      where: { id: parseId(id), shopId },
      include: { variants: { orderBy: { id: "asc" } } },
    }),
  );
}

// GET /app/parts/:id — stock per variant, movements, recipes (Rails PartsController#show).
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  const part = await findPart(shop.id, params.id);
  const currency = shopCurrency(shop);
  const [movements, services] = await Promise.all([
    prisma.stockMovement.findMany({
      where: { partVariantId: { in: part.variants.map((v) => v.id) } },
      orderBy: MOVEMENTS_ORDER,
      take: 30,
      include: { partVariant: true },
    }),
    prisma.repairService.findMany({
      where: { shopId: shop.id, components: { some: { partId: part.id } } },
      orderBy: SERVICES_ORDER,
    }),
  ]);
  const packed = !part.packSize.eq(1);
  return {
    part: {
      id: part.id,
      name: part.name,
      sku: part.sku,
      varies: varies(part),
      unit: part.unit,
      packed,
      packSize: decimal(part.packSize),
      counted: `Counted in ${part.unit}${packed ? `, bought in packs of ${decimal(part.packSize)}` : ""}`,
      cost: `Cost ${formatMoney(part.costPerUnit, currency)} per ${part.unit}`,
      reorder: `Reorder at ${quantityLabel(part, part.reorderLevel)} (buy ${quantityLabel(part, part.reorderQuantity)} more)`,
      notes: part.notes,
      options: partOptionNames(part).map((o) => ({ name: o, label: capitalize(o), placeholder: EXAMPLES[o] ?? "" })),
    },
    variants: part.variants.map((v) => ({
      id: v.id,
      label: variantLabel(v, part),
      sku: v.sku ?? "",
      onHand: quantityLabel(part, v.onHand),
      low: variantLow(v, part),
    })),
    movements: movements.map((m) => ({
      id: m.id,
      when: formatDateTime(m.createdAt),
      variant: variantLabel(m.partVariant, part),
      reason: statusLabel(m.reason),
      tone: movementTone(m.reason),
      quantity: `${m.quantity.gt(0) ? "+" : ""}${decimal(m.quantity)}`,
      ticketId: m.repairTicketId,
      note: m.note ?? "",
    })),
    services: services.map((s) => ({ id: s.id, title: s.title })),
  };
};

const INTENTS = ["generate", "update_variant", "delete_variant", "receive", "adjust"] as const;

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  requireParts(shop);
  const part = await findPart(shop.id, params.id);
  const path = `/app/parts/${part.id}`;
  const form = await readForm(request);
  const intent = parse(z.enum(INTENTS), field(form, "intent"));

  if (intent === "generate") {
    // One variant per combination of the comma-separated values for each option.
    const raw = nested(form, "values");
    const values = Object.fromEntries(
      partOptionNames(part).map((name) => [name, parse(zText(5000), raw[name] ?? "").split(",")]),
    );
    try {
      const created = await generateVariants(part.id, values);
      return redirectWithFlash(path, { notice: `${created} ${created === 1 ? "variant" : "variants"} added.` });
    } catch (error) {
      if (error instanceof ArgumentError) return redirectWithFlash(path, { alert: error.message });
      throw error;
    }
  }

  const variant = orNotFound(part.variants.find((v) => v.id === parseId(field(form, "variant_id"))));
  let flash: Flash;
  switch (intent) {
    case "update_variant":
      await prisma.partVariant.update({
        where: { id: variant.id },
        data: { sku: parse(zText(255), field(form, "sku")) || null },
      });
      flash = { notice: "Variant saved." };
      break;
    case "delete_variant": {
      const history =
        (await prisma.stockMovement.count({ where: { partVariantId: variant.id } })) +
        (await prisma.ticketPart.count({ where: { partVariantId: variant.id } }));
      if (history > 0) {
        flash = { alert: "This variant has stock history, so it can't be deleted." };
      } else {
        await prisma.partVariant.delete({ where: { id: variant.id } });
        flash = { notice: "Variant deleted." };
      }
      break;
    }
    case "receive": {
      // Stock bought in, entered in packs or units.
      let amount = quantity(field(form, "quantity"));
      if (amount && field(form, "in") === "packs") amount = amount.mul(part.packSize);
      if (!amount || !amount.gt(0)) {
        flash = { alert: "Enter how much arrived." };
        break;
      }
      await moveStock(variant.id, amount, {
        reason: "received",
        note: parse(zText(500), field(form, "note")) || null,
        by: STAFF,
      });
      flash = { notice: `Received ${quantityLabel(part, amount)} of ${variantLabel(variant, part)}.` };
      break;
    }
    case "adjust": {
      // A stock count: set on-hand to what's actually on the shelf.
      const counted = quantity(field(form, "counted"));
      if (!counted || counted.isNegative()) {
        flash = { alert: "Enter the counted quantity." };
        break;
      }
      const current = await prisma.partVariant.findUniqueOrThrow({ where: { id: variant.id } });
      const delta = counted.sub(current.onHand);
      if (!delta.isZero()) {
        await moveStock(variant.id, delta, {
          reason: "adjusted",
          note: parse(zText(500), field(form, "note")) || "Stock count",
          by: STAFF,
        });
      }
      const after = await prisma.partVariant.findUniqueOrThrow({ where: { id: variant.id } });
      flash = { notice: `${variantLabel(variant, part)} now ${quantityLabel(part, after.onHand)}.` };
      break;
    }
  }
  return redirectWithFlash(path, flash);
};

export default function PartPage() {
  const { part, variants, movements, services } = useLoaderData<typeof loader>();
  return (
    <s-page heading={part.name}>
      <s-link slot="breadcrumb-actions" href="/app/parts">
        Workshop inventory
      </s-link>
      <s-button slot="primary-action" href={`/app/parts/${part.id}/edit`}>
        Edit part
      </s-button>
      <s-grid grid-template-columns="2fr 1fr" gap="base">
        <s-stack direction="block" gap="base">
          <s-section heading="Stock">
            {variants.length ? (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header list-slot="primary">Variant</s-table-header>
                  <s-table-header>SKU</s-table-header>
                  <s-table-header list-slot="inline" format="numeric">
                    On hand
                  </s-table-header>
                  <s-table-header>Receive</s-table-header>
                  <s-table-header>Count</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {variants.map((v) => (
                    <s-table-row key={v.id}>
                      <s-table-cell>{v.label}</s-table-cell>
                      <s-table-cell>
                        <Form method="post">
                          <input type="hidden" name="intent" value="update_variant" />
                          <input type="hidden" name="variant_id" value={v.id} />
                          <s-stack direction="inline" gap="small-300" align-items="end">
                            <s-text-field
                              label="SKU"
                              label-accessibility-visibility="exclusive"
                              name="sku"
                              value={v.sku}
                              placeholder={part.sku ?? ""}
                            ></s-text-field>
                            <s-button type="submit" variant="tertiary" accessibility-label="Save SKU">
                              Save
                            </s-button>
                          </s-stack>
                        </Form>
                      </s-table-cell>
                      <s-table-cell>
                        {v.onHand}
                        {v.low ? <s-badge tone="warning">Low</s-badge> : null}
                      </s-table-cell>
                      <s-table-cell>
                        <Form method="post">
                          <input type="hidden" name="intent" value="receive" />
                          <input type="hidden" name="variant_id" value={v.id} />
                          <s-stack direction="inline" gap="small-300" align-items="end">
                            <s-number-field
                              label="Received"
                              label-accessibility-visibility="exclusive"
                              name="quantity"
                              min={0}
                              step={0.001}
                              placeholder="Qty"
                            ></s-number-field>
                            {part.packed ? (
                              <s-select label="In" label-accessibility-visibility="exclusive" name="in">
                                <s-option value="packs">packs of {part.packSize}</s-option>
                                <s-option value="units">{part.unit}</s-option>
                              </s-select>
                            ) : null}
                            <s-button type="submit" icon="plus" accessibility-label="Receive stock"></s-button>
                          </s-stack>
                        </Form>
                      </s-table-cell>
                      <s-table-cell>
                        <Form method="post">
                          <input type="hidden" name="intent" value="adjust" />
                          <input type="hidden" name="variant_id" value={v.id} />
                          <s-stack direction="inline" gap="small-300" align-items="end">
                            <s-number-field
                              label="Counted"
                              label-accessibility-visibility="exclusive"
                              name="counted"
                              min={0}
                              step={0.001}
                              placeholder="Count"
                            ></s-number-field>
                            <s-button type="submit" accessibility-label="Save stock count">
                              Set
                            </s-button>
                          </s-stack>
                        </Form>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            ) : (
              <s-paragraph color="subdued">No variants yet. Add them below.</s-paragraph>
            )}
          </s-section>

          {part.varies ? (
            <s-section heading="Add variants">
              <Form method="post">
                <input type="hidden" name="intent" value="generate" />
                <s-stack direction="block" gap="small-200">
                  <s-paragraph color="subdued">
                    Enter the values for each option, separated by commas. A variant is added for every combination
                    (existing ones are kept).
                  </s-paragraph>
                  {part.options.map((o) => (
                    <s-text-field key={o.name} label={o.label} name={`values[${o.name}]`} placeholder={o.placeholder}></s-text-field>
                  ))}
                  <s-stack direction="inline">
                    <s-button type="submit" icon="plus">
                      Add variants
                    </s-button>
                  </s-stack>
                </s-stack>
              </Form>
            </s-section>
          ) : null}

          <s-section heading="Recent stock movements">
            {movements.length ? (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header list-slot="secondary">Date</s-table-header>
                  <s-table-header list-slot="primary">Variant</s-table-header>
                  <s-table-header list-slot="inline">Reason</s-table-header>
                  <s-table-header format="numeric">Quantity</s-table-header>
                  <s-table-header>Note</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {movements.map((m) => (
                    <s-table-row key={m.id}>
                      <s-table-cell>{m.when}</s-table-cell>
                      <s-table-cell>{m.variant}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone={m.tone}>{m.reason}</s-badge>
                      </s-table-cell>
                      <s-table-cell>{m.quantity}</s-table-cell>
                      <s-table-cell>
                        {m.ticketId ? <s-link href={`/app/tickets/${m.ticketId}`}>Ticket #{m.ticketId}</s-link> : m.note}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            ) : (
              <s-paragraph color="subdued">No stock movements yet.</s-paragraph>
            )}
          </s-section>
        </s-stack>

        <s-stack direction="block" gap="base">
          <s-section heading="Details">
            <s-stack direction="block" gap="small-500">
              {part.sku ? <s-text>SKU {part.sku}</s-text> : null}
              <s-text>{part.counted}</s-text>
              <s-text>{part.cost}</s-text>
              <s-text>{part.reorder}</s-text>
              {part.notes ? <s-paragraph color="subdued">{part.notes}</s-paragraph> : null}
            </s-stack>
          </s-section>
          <s-section heading="Used in">
            {services.length ? (
              <s-stack direction="block" gap="small-300">
                {services.map((s) => (
                  <s-link key={s.id} href={`/app/repair_services/${s.id}`}>
                    {s.title}
                  </s-link>
                ))}
              </s-stack>
            ) : (
              <s-paragraph color="subdued">Not in any service recipe yet.</s-paragraph>
            )}
          </s-section>
        </s-stack>
      </s-grid>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
