// STUB(w2-admin): owned by w2-backend (Rails TradeIns::Workflow). Integration replaces this file.
/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures */
// The admin trade-in screens call these; each throws an Error whose message is shown to staff.
import type { TradeIn } from "@prisma/client";

export class InvalidTransition extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransition";
  }
}

interface Step {
  shopId: number;
  tradeInId: number;
  note?: string | null;
}

const notPorted = (): never => {
  throw new Error("Trade-in actions aren't available yet.");
};

export async function approveTradeIn(_args: Step): Promise<TradeIn> {
  return notPorted();
}

export async function rejectTradeIn(_args: Step): Promise<TradeIn> {
  return notPorted();
}

export async function cancelTradeIn(_args: Step): Promise<TradeIn> {
  return notPorted();
}

/** The item arrived: record its real condition and credit (blank credit = the program's value). */
export async function receiveTradeIn(
  _args: Step & { grade: string; credit: string | null },
): Promise<TradeIn> {
  return notPorted();
}

/** Issue the credit (store credit or a discount code); a failure leaves it received. */
export async function creditTradeIn(_args: { shopId: number; tradeInId: number }): Promise<TradeIn> {
  return notPorted();
}
