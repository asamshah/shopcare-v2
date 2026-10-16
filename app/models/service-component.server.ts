/**
 * One line of a service recipe: a part, how much of it, and how to pick the
 * right variant. For each of the part's options, the rule is:
 *   "item"          use the item's own attribute (its size, model, colour)
 *   "any"           staff choose on the ticket
 *   "fixed:<value>" always this value (e.g. "fixed:Black")
 * Port of ServiceComponent.
 */
import type { Part, Prisma, ServiceComponent } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { assertValid, Errors, jsonArray, jsonObject, validateNumber } from "./validation.server";

export type MatchRule = ["fixed", string] | ["any", null] | ["item", null];

/** [kind, value] for one of the part's options; "item" by default. */
export function ruleFor(component: Pick<ServiceComponent, "match">, option: string): MatchRule {
  const raw = jsonObject(component.match)[option];
  const rule = raw === null || raw === undefined ? "" : String(raw);
  if (rule.startsWith("fixed:")) return ["fixed", rule.slice("fixed:".length)];
  if (rule === "any") return ["any", null];
  return ["item", null];
}

export function ruleSummary(
  component: Pick<ServiceComponent, "match">,
  part: Pick<Part, "optionNames">,
): string {
  return jsonArray(part.optionNames)
    .map(String)
    .map((option) => {
      const [kind, value] = ruleFor(component, option);
      if (kind === "fixed") return `${option}: ${value}`;
      if (kind === "any") return `${option}: staff choose`;
      return `${option}: from item`;
    })
    .join(", ");
}

export async function validateServiceComponent(
  data: Pick<Prisma.ServiceComponentUncheckedCreateInput, "quantity" | "partId" | "repairServiceId">,
  db: Db = prisma,
): Promise<Errors> {
  const errors = new Errors();
  validateNumber(errors, "quantity", data.quantity ?? 1, { greaterThan: 0 });
  const [part, service] = await Promise.all([
    db.part.findUnique({ where: { id: data.partId }, select: { shopId: true } }),
    db.repairService.findUnique({ where: { id: data.repairServiceId }, select: { shopId: true } }),
  ]);
  if (part && service && part.shopId !== service.shopId) {
    errors.add("part", "must belong to the same shop");
  }
  return errors;
}

export async function createServiceComponent(
  data: Prisma.ServiceComponentUncheckedCreateInput,
  db: Db = prisma,
): Promise<ServiceComponent> {
  assertValid("ServiceComponent", await validateServiceComponent(data, db));
  return db.serviceComponent.create({ data });
}
