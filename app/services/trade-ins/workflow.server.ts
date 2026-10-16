/**
 * Staff steps for a trade-in, each logged in the staff note and sent to the
 * customer (`trade_in_status_changed`, through the merchant's Flow / Klaviyo).
 * Port of TradeIns::Workflow. Each step throws an Error whose message is
 * shown to staff (InvalidTransition for a step out of order).
 *
 * Crediting claims the trade-in as `crediting` under its row lock before
 * Shopify is called, so a double-click or a second staff member can't issue
 * the credit twice; a failed issue puts it back to `received`.
 */
import type { Prisma, Shop, TradeIn } from "@prisma/client";
import prisma from "../../db.server";
import { inTransaction, withRowLock } from "../../lib/db-lock.server";
import { longDate } from "../../lib/dates";
import { humanize } from "../../lib/inflections";
import { findItemWithCovers } from "../../models/item.server";
import { creditFor, findGrade } from "../../models/trade-in-program.server";
import { updateTradeIn } from "../../models/trade-in.server";
import { toDecimal } from "../../models/validation.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import { clientFor, shopCurrencyOf } from "../quotes/common.server";
import type { NotifyOptions } from "../notifications/notify.server";
import { issueTradeInCredit, type CreditMethod } from "./credit-issuer.server";
import { notifyTradeInStatus } from "./notify-status.server";
import { quoteCreditFor, TradeInQuoter } from "./quoter.server";

export class InvalidTransition extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransition";
  }
}

export interface WorkflowOptions {
  /** The shop's Admin API client; defaults to its offline session. */
  client?: AdminGraphqlClient;
  db?: typeof prisma;
  now?: Date;
  notifyOptions?: NotifyOptions;
  /** Issues the credit (tests); defaults to issueTradeInCredit. */
  issueCredit?: (
    shop: Shop,
    tradeIn: TradeIn,
  ) => Promise<{ method: CreditMethod; reference: string }>;
}

interface Step extends WorkflowOptions {
  shopId: number;
  tradeInId: number;
  note?: string | null;
}

export function approveTradeIn(args: Step): Promise<TradeIn> {
  return transition(args, ["requested"], "approved");
}

export function rejectTradeIn(args: Step): Promise<TradeIn> {
  return transition(args, ["requested", "approved", "received"], "rejected");
}

export function cancelTradeIn(args: Step): Promise<TradeIn> {
  return transition(args, ["pending_purchase", "requested", "approved"], "cancelled", {
    notify: false,
  });
}

/**
 * The item arrived: record its real condition and the credit it earns (the
 * program's value for that condition, unless staff enter an amount).
 */
export async function receiveTradeIn(
  args: Step & { grade: string; credit: string | null },
): Promise<TradeIn> {
  const entered = args.credit?.trim() || null;
  const credit = entered !== null ? toDecimal(entered) : await regradedCredit(args, args.grade);
  if (credit === null || credit.isNegative())
    throw new InvalidTransition("Enter the credit for this item");
  return transition(args, ["requested", "approved"], "received", {
    extra: { finalGrade: args.grade, finalCredit: credit },
  });
}

/**
 * Issue the credit (store credit, or a discount code), and mark the item
 * traded in so its cover ends.
 */
export async function creditTradeIn(args: Omit<Step, "note">): Promise<TradeIn> {
  const { db = prisma, now = new Date() } = args;
  const shop = await db.shop.findUniqueOrThrow({ where: { id: args.shopId } });
  const claimed = await db.$transaction(async (tx) => {
    const found = await tx.tradeIn.findFirst({
      where: { id: args.tradeInId, shopId: args.shopId },
    });
    if (!found) throw new Error("Trade-in not found.");
    await withRowLock(tx, "trade_ins", found.id);
    const tradeIn = await tx.tradeIn.findUniqueOrThrow({
      where: { id: found.id },
      include: { item: true },
    });
    if (tradeIn.status !== "received") throw new InvalidTransition("Receive the item first");
    if (tradeIn.item && tradeIn.item.status !== "active")
      throw new InvalidTransition(
        `This item is no longer active (${humanize(tradeIn.item.status).toLowerCase()})`,
      );
    return tx.tradeIn.update({ where: { id: tradeIn.id }, data: { status: "crediting" } });
  });

  let issued: { method: CreditMethod; reference: string };
  try {
    issued = await (args.issueCredit ?? defaultIssuer(args))(shop, claimed);
  } catch (error) {
    // Nothing was issued; staff can retry.
    await db.tradeIn.update({ where: { id: claimed.id }, data: { status: "received" } });
    throw error;
  }

  const credited = await inTransaction(db, async (tx) => {
    const updated = await tx.tradeIn.update({
      where: { id: claimed.id },
      data: {
        status: "credited",
        creditMethod: issued.method,
        creditReference: issued.reference,
        creditedAt: now,
      },
    });
    if (updated.itemId) {
      await tx.item.update({ where: { id: updated.itemId }, data: { status: "traded_in" } });
      await tx.cover.updateMany({
        where: { itemId: updated.itemId, status: "active" },
        data: { status: "cancelled" },
      });
    }
    return updated;
  });
  await notifyTradeInStatus(shop, credited, { db, ...args.notifyOptions });
  return credited;
}

function defaultIssuer(options: WorkflowOptions) {
  return async (shop: Shop, tradeIn: TradeIn) => {
    const client = await clientFor(shop, options.client);
    const shopCurrency = tradeIn.currency || (await shopCurrencyOf(client)());
    return issueTradeInCredit(shop, client, tradeIn, { shopCurrency, now: options.now });
  };
}

/**
 * The program's credit for the grade staff found, priced the same way as the
 * customer's quote (what they paid, plus any Care bonus).
 */
async function regradedCredit(args: Step, grade: string) {
  const { db = prisma, now = new Date() } = args;
  const tradeIn = await db.tradeIn.findFirstOrThrow({
    where: { id: args.tradeInId, shopId: args.shopId },
    include: { tradeInProgram: true },
  });
  const program = tradeIn.tradeInProgram;
  if (!program || !findGrade(program, grade)) return null;

  const quoter = new TradeInQuoter({ id: args.shopId }, { db, now });
  const quote = tradeIn.itemId
    ? await quoter.forItem(await findItemWithCovers(tradeIn.itemId, db))
    : await quoter.forUnknown();
  return quote?.program.id === program.id ? quoteCreditFor(quote, grade) : creditFor(program, grade);
}

async function transition(
  args: Step,
  from: string[],
  to: string,
  {
    notify = true,
    extra = {},
  }: { notify?: boolean; extra?: Prisma.TradeInUncheckedUpdateInput } = {},
): Promise<TradeIn> {
  const { db = prisma, now = new Date() } = args;
  const updated = await db.$transaction(async (tx) => {
    const found = await tx.tradeIn.findFirst({
      where: { id: args.tradeInId, shopId: args.shopId },
    });
    if (!found) throw new Error("Trade-in not found.");
    await withRowLock(tx, "trade_ins", found.id);
    const tradeIn = await tx.tradeIn.findUniqueOrThrow({ where: { id: found.id } });
    if (!from.includes(tradeIn.status))
      throw new InvalidTransition(
        `Can't move a ${humanize(tradeIn.status).toLowerCase()} trade-in to ${to}`,
      );
    const note = args.note?.trim();
    const notes = [tradeIn.staffNote?.trim() || null, note ? `${longDate(now)}: ${note}` : null]
      .filter(Boolean)
      .join("\n");
    return updateTradeIn(tradeIn.id, { ...extra, status: to, staffNote: notes || null }, tx);
  });
  if (notify) {
    const shop = await db.shop.findUniqueOrThrow({ where: { id: args.shopId } });
    await notifyTradeInStatus(shop, updated, { db, ...args.notifyOptions });
  }
  return updated;
}
