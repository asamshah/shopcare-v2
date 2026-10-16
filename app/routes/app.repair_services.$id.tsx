import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";
import prisma from "../db.server";
import { checkedIf } from "../components/attrs";
import { capitalize } from "../lib/format";
import { formatMoney } from "../lib/format.server";
import { OPTION_NAMES, partOptionNames, quantityLabel, varies, ORDERED as PARTS_ORDERED } from "../models/part.server";
import { partsCost, updateRepairService } from "../models/repair-service.server";
import { createServiceComponent, ruleSummary } from "../models/service-component.server";
import { labourRate, partsEnabled } from "../models/shop.server";
import { ValidationError } from "../models/validation.server";
import { orNotFound, parseId, requireAdmin, requireParts } from "../services/admin/context.server";
import { redirectWithFlash } from "../services/admin/flash.server";
import { bool, field, has, parse, readForm, zDecimal, zInt } from "../services/admin/form.server";
import { shopCurrency } from "../services/admin/tickets.server";

async function findService(shopId: number, id: number) {
  return orNotFound(await prisma.repairService.findFirst({ where: { id, shopId } }));
}

// GET /app/repair_services/:id — edit a service and its recipe (Rails #edit).
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const service = await findService(shop.id, parseId(params.id));
  const currency = shopCurrency(shop);
  const withParts = partsEnabled(shop);
  const components = withParts
    ? await prisma.serviceComponent.findMany({
        where: { repairServiceId: service.id },
        orderBy: { id: "asc" },
        include: { part: true },
      })
    : [];
  const parts = withParts
    ? await prisma.part.findMany({ where: { shopId: shop.id, active: true }, orderBy: PARTS_ORDERED })
    : [];
  const cost = await partsCost(service.id);
  const rate = labourRate(shop);
  const labour = rate.mul(service.labourMinutes).div(60);
  return {
    service: {
      id: service.id,
      title: service.title,
      price: formatMoney(service.price, currency),
      labourMinutes: service.labourMinutes,
      active: service.active,
    },
    partsEnabled: withParts,
    components: components.map((c) => ({
      id: c.id,
      partId: c.partId,
      partName: c.part.name,
      quantity: quantityLabel(c.part, c.quantity),
      rule: varies(c.part) ? ruleSummary(c, c.part) : "—",
      cost: formatMoney(c.quantity.mul(c.part.costPerUnit), currency),
    })),
    parts: parts.map((p) => ({
      id: p.id,
      label: `${p.name}${varies(p) ? ` (${partOptionNames(p).join(" × ")})` : ""} · ${p.unit}`,
    })),
    options: OPTION_NAMES.map((o) => ({ name: o, label: capitalize(o) })),
    costs: {
      parts: formatMoney(cost, currency),
      labour: formatMoney(labour, currency),
      noRate: rate.isZero(),
      margin: formatMoney(service.price.sub(cost).sub(labour), currency),
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  const service = await findService(shop.id, parseId(params.id));
  const path = `/app/repair_services/${service.id}`;
  const form = await readForm(request);
  const intent = parse(z.enum(["update", "add_component", "remove_component"]), field(form, "intent"));

  if (intent === "update") {
    const minutes = has(form, "labour_minutes") ? parse(zInt, field(form, "labour_minutes")) : null;
    try {
      await updateRepairService(service.id, {
        active: bool(form, "active"),
        ...(minutes === null ? {} : { labourMinutes: minutes }),
      });
    } catch (error) {
      if (error instanceof ValidationError) return redirectWithFlash(path, { alert: error.errors.fullMessages().join(", ") });
      throw error;
    }
    return redirectWithFlash(path, { notice: "Service saved." });
  }

  requireParts(shop);
  if (intent === "remove_component") {
    const component = orNotFound(
      await prisma.serviceComponent.findFirst({
        where: { id: parseId(field(form, "component_id")), repairServiceId: service.id },
      }),
    );
    await prisma.serviceComponent.delete({ where: { id: component.id } });
    return redirectWithFlash(path, { notice: "Part removed from the recipe." });
  }

  const part = orNotFound(await prisma.part.findFirst({ where: { id: parseId(field(form, "part_id")), shopId: shop.id } }));
  const quantity = parse(zDecimal, field(form, "quantity")) ?? "1";
  // One rule per part option: "item", "any", or a fixed value.
  const match = Object.fromEntries(
    partOptionNames(part).map((option) => {
      const rule = field(form, `match[${option}]`);
      const fixed = field(form, `fixed[${option}]`).trim().slice(0, 255);
      return [option, rule === "fixed" && fixed ? `fixed:${fixed}` : rule === "any" ? "any" : "item"];
    }),
  );
  try {
    await createServiceComponent({ repairServiceId: service.id, partId: part.id, quantity, match });
  } catch (error) {
    if (error instanceof ValidationError) return redirectWithFlash(path, { alert: error.errors.fullMessages().join(", ") });
    throw error;
  }
  return redirectWithFlash(path, { notice: `${part.name} added to the recipe.` });
};

function ServiceForm({ d }: { d: ReturnType<typeof useLoaderData<typeof loader>> }) {
  return (
    <s-section heading="Service">
      <Form method="post">
        <input type="hidden" name="intent" value="update" />
        <s-stack direction="block" gap="small-200">
          <s-text>Price {d.service.price} (from Shopify)</s-text>
          {d.partsEnabled ? (
            <s-number-field
              label="Labour (minutes)"
              name="labour_minutes"
              value={String(d.service.labourMinutes)}
              min={0}
            ></s-number-field>
          ) : null}
          <input type="hidden" name="active" value="0" />
          <s-checkbox name="active" value="1" label="Active" {...checkedIf(d.service.active)}></s-checkbox>
          <s-stack direction="inline">
            <s-button variant="primary" type="submit">
              Save
            </s-button>
          </s-stack>
        </s-stack>
      </Form>
    </s-section>
  );
}

export default function RepairService() {
  const d = useLoaderData<typeof loader>();
  return (
    <s-page heading={d.service.title}>
      <s-link slot="breadcrumb-actions" href="/app/repair_services">
        Repair services
      </s-link>
      {d.partsEnabled ? (
        <s-grid grid-template-columns="2fr 1fr" gap="base">
          <s-stack direction="block" gap="base">
            <s-section heading="Recipe">
              <s-stack direction="block" gap="base">
                {d.components.length ? (
                  <s-table variant="auto">
                    <s-table-header-row>
                      <s-table-header list-slot="primary">Part</s-table-header>
                      <s-table-header format="numeric">Quantity</s-table-header>
                      <s-table-header>Variant matched by</s-table-header>
                      <s-table-header format="currency">Cost</s-table-header>
                      <s-table-header></s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {d.components.map((c) => (
                        <s-table-row key={c.id}>
                          <s-table-cell>
                            <s-link href={`/app/parts/${c.partId}`}>{c.partName}</s-link>
                          </s-table-cell>
                          <s-table-cell>{c.quantity}</s-table-cell>
                          <s-table-cell>{c.rule}</s-table-cell>
                          <s-table-cell>{c.cost}</s-table-cell>
                          <s-table-cell>
                            <Form method="post">
                              <input type="hidden" name="intent" value="remove_component" />
                              <input type="hidden" name="component_id" value={c.id} />
                              <s-button
                                variant="tertiary"
                                tone="critical"
                                type="submit"
                                icon="delete"
                                accessibility-label="Remove from recipe"
                              ></s-button>
                            </Form>
                          </s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                ) : (
                  <s-paragraph color="subdued">No parts in this recipe yet.</s-paragraph>
                )}
                <s-divider></s-divider>
                {d.parts.length ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="add_component" />
                    <s-stack direction="block" gap="small-200">
                      <s-grid grid-template-columns="3fr 1fr" gap="small-200">
                        <s-select label="Add part" name="part_id">
                          {d.parts.map((p) => (
                            <s-option key={p.id} value={String(p.id)}>
                              {p.label}
                            </s-option>
                          ))}
                        </s-select>
                        <s-number-field label="Quantity" name="quantity" value="1" min={0.001} step={0.001}></s-number-field>
                      </s-grid>
                      <s-paragraph color="subdued">
                        For parts with variants, choose how the right one is picked. “From the item” uses the
                        customer&apos;s item: its size, its model (product metafield) and its colour.
                      </s-paragraph>
                      <s-grid grid-template-columns="1fr 1fr 1fr" gap="small-200">
                        {d.options.map((o) => (
                          <s-stack key={o.name} direction="block" gap="small-300">
                            <s-select label={o.label} name={`match[${o.name}]`}>
                              <s-option value="item">From the item</s-option>
                              <s-option value="any">Staff choose</s-option>
                              <s-option value="fixed">Always…</s-option>
                            </s-select>
                            <s-text-field
                              label="Always (value)"
                              label-accessibility-visibility="exclusive"
                              name={`fixed[${o.name}]`}
                              placeholder="Value if “Always…”"
                            ></s-text-field>
                          </s-stack>
                        ))}
                      </s-grid>
                      <s-stack direction="inline">
                        <s-button type="submit" icon="plus">
                          Add to recipe
                        </s-button>
                      </s-stack>
                    </s-stack>
                  </Form>
                ) : (
                  <s-paragraph color="subdued">
                    <s-link href="/app/parts/new">Add parts</s-link> first, then build the recipe.
                  </s-paragraph>
                )}
              </s-stack>
            </s-section>
          </s-stack>
          <s-stack direction="block" gap="base">
            <ServiceForm d={d} />
            <s-section heading="Cost per repair">
              <s-stack direction="block" gap="small-500">
                <s-text>Parts {d.costs.parts}</s-text>
                <s-text>
                  Labour {d.costs.labour}
                  {d.costs.noRate ? " (set a labour rate in Settings)" : ""}
                </s-text>
                <s-text type="strong">Margin {d.costs.margin}</s-text>
              </s-stack>
            </s-section>
          </s-stack>
        </s-grid>
      ) : (
        <ServiceForm d={d} />
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
