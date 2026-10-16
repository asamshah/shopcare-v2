/** Product groups admin (Rails ProductGroupsController). */
import type { ProductGroup } from "@prisma/client";
import { groupCollections, groupTags } from "../../models/product-group.server";
import { field, type Form, parse, zText } from "./form.server";

export interface GroupValues {
  name: string;
  rule: string;
  collections: { id: string; title: string }[];
  tags: string;
  productType: string;
}

export const groupValues = (g: Pick<ProductGroup, "name" | "rule" | "collections" | "tags" | "productType">): GroupValues => ({
  name: g.name,
  rule: g.rule,
  collections: groupCollections(g).map((c) => ({ id: c.id, title: c.title })),
  tags: groupTags(g).join(", "),
  productType: g.productType ?? "",
});

/** The form, with the resource picker's choice as a JSON list of { id, title }. */
export function readGroup(form: Form) {
  let collections: { id: string; title: string }[] = [];
  try {
    const parsed: unknown = JSON.parse(field(form, "collections_json") || "[]");
    if (Array.isArray(parsed)) {
      collections = parsed
        .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object" && !Array.isArray(c))
        .slice(0, 250)
        .map((c) => ({ id: String(c.id ?? "").slice(0, 100), title: String(c.title ?? "").slice(0, 255) }));
    }
  } catch {
    collections = [];
  }
  const values: GroupValues = {
    name: parse(zText(255), field(form, "name")),
    rule: parse(zText(20), field(form, "rule")) || "collections",
    collections,
    tags: parse(zText(2000), field(form, "tags")),
    productType: parse(zText(255), field(form, "product_type")),
  };
  const input = {
    name: values.name,
    rule: values.rule,
    collections: values.collections,
    tags: values.tags.split(","),
    productType: values.productType,
  };
  return { values, input };
}
