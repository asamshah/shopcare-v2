/**
 * Gives a new Item the warranty cover its shop's policies say it should have
 * (the first active policy, by position, whose product group matches), and
 * notes which Care plans it could have. Only asks Shopify about the product
 * when a policy or plan filters on tags, collections or product type.
 * Port of Warranty::CoverAssigner.
 *
 * `factsFor` and `assign` are separate so a caller can fetch product facts
 * (a Shopify call) before opening its transaction, and assign inside it.
 */
import type { Cover, Item, Prisma } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { activeCarePlans, type CarePlanWithGroup } from "../../models/care-plan.server";
import { createCover, warrantyCoverFor } from "../../models/cover.server";
import { eligibleCarePlanIds } from "../../models/item.server";
import { emptyFacts, type ProductFacts } from "../../models/product-facts";
import { appliesTo, needsProductFacts } from "../../models/product-grouped.server";
import {
  activeWarrantyPolicies,
  type WarrantyPolicyWithGroup,
} from "../../models/warranty-policy.server";

/** Where product facts come from: ProductFactsLoader in production. */
export interface ProductFactsSource {
  fetch(productId: string | null | undefined): Promise<ProductFacts | null>;
}

export class CoverAssigner {
  private rules?: Promise<{
    policies: WarrantyPolicyWithGroup[];
    carePlans: CarePlanWithGroup[];
  }>;

  constructor(
    private shop: { id: number },
    private facts: ProductFactsSource | null,
    private db: Db = prisma,
  ) {}

  private loadRules() {
    return (this.rules ??= Promise.all([
      activeWarrantyPolicies(this.shop.id, this.db),
      activeCarePlans(this.shop.id, this.db),
    ]).then(([policies, carePlans]) => ({ policies, carePlans })));
  }

  /** Facts for the product, fetched only when some policy or plan needs them. */
  async factsFor(productId: string | null | undefined): Promise<ProductFacts> {
    const { policies, carePlans } = await this.loadRules();
    const needed = [...policies, ...carePlans].some((r) => needsProductFacts(r));
    if (!needed || !this.facts) return emptyFacts(productId ?? null);
    return (await this.facts.fetch(productId)) ?? emptyFacts(productId ?? null);
  }

  /**
   * Creates and returns the warranty Cover, or null when no policy applies.
   * Pass `facts` when the caller already has them; `db` to run inside the
   * caller's transaction.
   */
  async assign(
    item: Item,
    { facts, db = this.db }: { facts?: ProductFacts; db?: Db } = {},
  ): Promise<Cover | null> {
    const { policies, carePlans } = await this.loadRules();
    if (policies.length === 0 && carePlans.length === 0) return null;

    const known = facts ?? (await this.factsFor(item.productId));
    const eligible = carePlans.filter((plan) => appliesTo(plan, known)).map((plan) => plan.id);
    const current = eligibleCarePlanIds(item);
    if (eligible.length !== current.length || eligible.some((id, i) => id !== current[i])) {
      await db.item.update({
        where: { id: item.id },
        data: { eligibleCarePlanIds: eligible as Prisma.InputJsonValue },
      });
    }

    const policy = policies.find((candidate) => appliesTo(candidate, known));
    if (!policy) return null;
    return createCover(warrantyCoverFor(item, policy), db);
  }
}
