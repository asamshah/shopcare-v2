/**
 * A named set of products, defined once and shared by warranty policies and
 * Care plans (a plan or policy with no group applies to all products). The
 * rule is one of: all products, any of some collections (chosen with the
 * resource picker, stored as GIDs + titles), any of some tags, or a product
 * type. Port of ProductGroup.
 */
import type { ProductGroup } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { toSentence } from "../lib/inflections";
import { buildGid, numericId } from "../lib/gid";
import type { ProductFacts } from "./product-facts";
import {
  assertValid,
  Errors,
  jsonArray,
  validateInclusion,
  validatePresence,
} from "./validation.server";

export const PRODUCT_GROUP_RULES = ["all", "collections", "tags", "product_type"] as const;
export type ProductGroupRule = (typeof PRODUCT_GROUP_RULES)[number];

// A type alias (not an interface) so it is assignable to Prisma JSON input.
export type GroupCollection = {
  id: string;
  title: string;
};

export type ProductGroupMatchable = Pick<
  ProductGroup,
  "rule" | "collections" | "tags" | "productType"
>;

export interface ProductGroupInput {
  shopId: number;
  name?: string;
  rule?: string;
  collections?: unknown[];
  tags?: unknown[];
  productType?: string | null;
}

export interface NormalizedProductGroup {
  shopId: number;
  name: string;
  rule: string;
  collections: GroupCollection[];
  tags: string[];
  productType: string | null;
}

export const groupCollections = (group: Pick<ProductGroup, "collections">) =>
  jsonArray(group.collections) as GroupCollection[];
export const groupTags = (group: Pick<ProductGroup, "tags">) =>
  jsonArray(group.tags).map(String);

/** Rails `before_validation :normalise`: tidy values, keep only the rule's own. */
export function normalizeProductGroup(input: ProductGroupInput): NormalizedProductGroup {
  const rule = input.rule ?? "all";
  const seenTags = new Set<string>();
  const tags = (input.tags ?? [])
    .map((tag) => String(tag ?? "").trim())
    .filter((tag) => {
      if (tag === "" || seenTags.has(tag.toLowerCase())) return false;
      seenTags.add(tag.toLowerCase());
      return true;
    });
  const seenIds = new Set<string>();
  const collections: GroupCollection[] = [];
  for (const raw of input.collections ?? []) {
    const collection = (raw ?? {}) as Record<string, unknown>;
    let id = String(collection.id ?? "").trim();
    if (/^\d+$/.test(id)) id = buildGid("Collection", id);
    if (!id.startsWith("gid://shopify/Collection/") || seenIds.has(id)) continue;
    seenIds.add(id);
    const title = String(collection.title ?? "").trim();
    collections.push({ id, title: title || `Collection ${numericId(id)}` });
  }
  const productType = (input.productType ?? "").trim() || null;
  return {
    shopId: input.shopId,
    name: (input.name ?? "").trim(),
    rule,
    collections: rule === "collections" ? collections : [],
    tags: rule === "tags" ? tags : [],
    productType: rule === "product_type" ? productType : null,
  };
}

/** Validations that don't need the database. */
export function validateProductGroup(group: NormalizedProductGroup): Errors {
  const errors = new Errors();
  validatePresence(errors, "name", group.name);
  validateInclusion(errors, "rule", group.rule, PRODUCT_GROUP_RULES);
  if (group.rule === "collections" && group.collections.length === 0)
    errors.add("collections", "choose at least one");
  if (group.rule === "tags" && group.tags.length === 0) errors.add("tags", "add at least one");
  if (group.rule === "product_type" && !group.productType)
    errors.add("productType", "can't be blank");
  return errors;
}

async function validateWithDb(
  db: Db,
  group: NormalizedProductGroup,
  id?: number,
): Promise<Errors> {
  const errors = validateProductGroup(group);
  if (group.name) {
    const clash = await db.productGroup.findFirst({
      where: {
        shopId: group.shopId,
        name: { equals: group.name, mode: "insensitive" },
        ...(id ? { NOT: { id } } : {}),
      },
      select: { id: true },
    });
    if (clash) errors.add("name", "has already been taken");
  }
  return errors;
}

/** Normalises, validates (incl. the per-shop unique name) and saves. */
export async function createProductGroup(
  input: ProductGroupInput,
  db: Db = prisma,
): Promise<ProductGroup> {
  const group = normalizeProductGroup(input);
  assertValid("ProductGroup", await validateWithDb(db, group));
  return db.productGroup.create({ data: group });
}

export async function updateProductGroup(
  id: number,
  patch: Partial<Omit<ProductGroupInput, "shopId">>,
  db: Db = prisma,
): Promise<ProductGroup> {
  const current = await db.productGroup.findUniqueOrThrow({ where: { id } });
  const group = normalizeProductGroup({
    shopId: current.shopId,
    name: current.name,
    rule: current.rule,
    collections: jsonArray(current.collections),
    tags: jsonArray(current.tags),
    productType: current.productType,
    ...patch,
  });
  assertValid("ProductGroup", await validateWithDb(db, group, id));
  return db.productGroup.update({ where: { id }, data: group });
}

/** Does Shopify need asking about the product (tags, type, collections)? */
export function productGroupNeedsFacts(group: Pick<ProductGroup, "rule">): boolean {
  return group.rule !== "all";
}

/** Numeric collection ids, as product facts report them. */
export function productGroupCollectionIds(group: Pick<ProductGroup, "collections">): string[] {
  return groupCollections(group).map((collection) => numericId(collection.id));
}

export function productGroupMatches(group: ProductGroupMatchable, facts: ProductFacts): boolean {
  switch (group.rule) {
    case "all":
      return true;
    case "collections": {
      const ids = productGroupCollectionIds(group);
      return ids.some((id) => facts.collectionIds.includes(id));
    }
    case "tags": {
      const factTags = facts.tags.map((tag) => tag.toLowerCase());
      return groupTags(group).some((tag) => factTags.includes(tag.toLowerCase()));
    }
    case "product_type":
      return (
        (facts.productType ?? "").toLowerCase() === (group.productType ?? "").toLowerCase()
      );
    default:
      return false;
  }
}

export function productGroupSummary(group: ProductGroupMatchable): string | null {
  switch (group.rule) {
    case "all":
      return "All products";
    case "collections":
      return `In ${toSentence(groupCollections(group).map((c) => c.title), "or")}`;
    case "tags":
      return `Tagged ${toSentence(groupTags(group).map((t) => `“${t}”`), "or")}`;
    case "product_type":
      return `Product type “${group.productType}”`;
    default:
      return null;
  }
}

export async function productGroupInUse(id: number, db: Db = prisma): Promise<boolean> {
  const [plans, policies] = await Promise.all([
    db.carePlan.count({ where: { productGroupId: id } }),
    db.warrantyPolicy.count({ where: { productGroupId: id } }),
  ]);
  return plans + policies > 0;
}

/**
 * Deletes the group unless a plan or policy uses it (Rails
 * `dependent: :restrict_with_error`). Returns false when it's in use; the
 * foreign keys (NO ACTION) also refuse such a delete.
 */
export async function deleteProductGroup(id: number, db: Db = prisma): Promise<boolean> {
  if (await productGroupInUse(id, db)) return false;
  await db.productGroup.delete({ where: { id } });
  return true;
}
