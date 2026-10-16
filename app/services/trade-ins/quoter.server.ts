/**
 * What a customer could get for trading something in: the first active
 * trade-in program (by position) that takes the product, with the credit for
 * each condition grade. Items bought from the shop are matched by product and
 * priced from what was paid; "something else" (no item) can only use
 * programs open to all products with fixed credit. Port of TradeIns::Quoter.
 *
 * Shopify is only asked when it's needed (product facts for filtered
 * programs, today's price for a registration with no recorded price), through
 * the injected `facts` / `variantPrice`; without them those programs don't
 * match.
 */
import type { Item, Prisma, Shop, TradeInProgram } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { careCover, type ItemWithCovers } from "../../models/item.server";
import { eligibilityAppliesTo, eligibilityMode } from "../../models/product-eligibility.server";
import { emptyFacts, type ProductFacts } from "../../models/product-facts";
import {
  acceptsAge,
  creditFor,
  ORDERED,
  programGrades,
} from "../../models/trade-in-program.server";
import { d, jsonObject } from "../../models/validation.server";

export interface QuoteGrade {
  key: string;
  label: string;
  description: string;
  credit: Prisma.Decimal | null;
}

export interface TradeInQuote {
  program: TradeInProgram;
  grades: QuoteGrade[];
  bonusPercent: Prisma.Decimal;
}

export function quoteCreditFor(quote: TradeInQuote, key: string): Prisma.Decimal | null {
  return quote.grades.find((grade) => grade.key === String(key))?.credit ?? null;
}

export interface QuoterDeps {
  db?: Db;
  /** Product facts by numeric product id (ProductFactsLoader#fetch). */
  facts?: (productId: string) => Promise<ProductFacts | null>;
  /** Today's price of a variant (numeric id), as a decimal string. */
  variantPrice?: (variantId: string) => Promise<string | null>;
  now?: Date;
}

export class TradeInQuoter {
  private programs: Promise<TradeInProgram[]> | null = null;
  private db: Db;
  private now: Date;

  constructor(
    private shop: Pick<Shop, "id">,
    private deps: QuoterDeps = {},
  ) {
    this.db = deps.db ?? prisma;
    this.now = deps.now ?? new Date();
  }

  async forItem(item: ItemWithCovers): Promise<TradeInQuote | null> {
    if (item.status !== "active") return null;
    const programs = (await this.activePrograms()).filter((p) =>
      acceptsAge(p, item.purchasedAt, this.now),
    );
    if (programs.length === 0) return null;

    const facts = await this.factsFor(item, programs);
    const program = programs.find((p) => eligibilityAppliesTo(p.eligibility, facts));
    if (!program) return null;

    const percent = program.creditMode === "percent";
    const paid = percent ? await this.pricePaid(item) : null;
    if (percent && paid === null) return null;

    const terms = jsonObject(careCover(item, this.now)?.terms ?? undefined);
    const perks = jsonObject(terms.perks as Prisma.JsonValue | undefined);
    const bonus = d(perks.trade_in_bonus_percent);
    return build(program, paid, bonus);
  }

  /** Something the shop has no record of (bought elsewhere, or long ago). */
  async forUnknown(): Promise<TradeInQuote | null> {
    const program = (await this.activePrograms()).find(
      (p) => p.creditMode === "fixed" && eligibilityMode(p.eligibility) === "all",
    );
    return program ? build(program, null, d(0)) : null;
  }

  private activePrograms(): Promise<TradeInProgram[]> {
    this.programs ??= this.db.tradeInProgram.findMany({
      where: { shopId: this.shop.id, active: true },
      orderBy: ORDERED,
    });
    return this.programs;
  }

  /** Empty facts (only all-products programs match) when they can't be fetched. */
  private async factsFor(
    item: Pick<Item, "productId">,
    programs: TradeInProgram[],
  ): Promise<ProductFacts> {
    const empty = emptyFacts(item.productId);
    if (programs.every((p) => eligibilityMode(p.eligibility) === "all")) return empty;
    if (!this.deps.facts || !item.productId) return empty;
    return (await this.deps.facts(item.productId)) ?? empty;
  }

  /** What they paid, or today's price if it was never recorded (registrations). */
  private async pricePaid(item: Pick<Item, "unitPrice" | "variantId">): Promise<Prisma.Decimal | null> {
    if (item.unitPrice && d(item.unitPrice).gt(0)) return d(item.unitPrice);
    if (!item.variantId || !this.deps.variantPrice) return null;
    const price = await this.deps.variantPrice(item.variantId);
    return price ? d(price) : null;
  }
}

function build(
  program: TradeInProgram,
  paid: Prisma.Decimal | null,
  bonus: Prisma.Decimal,
): TradeInQuote {
  return {
    program,
    bonusPercent: bonus,
    grades: programGrades(program).map((grade) => ({
      key: grade.key,
      label: grade.label,
      description: grade.description,
      credit: creditFor(program, grade.key, { paid, bonusPercent: bonus }),
    })),
  };
}
