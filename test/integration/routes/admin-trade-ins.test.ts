/**
 * Trade-in admin screens (behind the per-shop flag): the admin half of Rails
 * trade_ins_test.rb. The workflow (approve/receive/credit) is w2-backend's
 * TradeIns::Workflow port, mocked here.
 */
import { describe, expect, it, vi } from "vitest";
import prisma from "../../../app/db.server";
import { loader as appLoader } from "../../../app/routes/app";
import { loader as settingsLoader } from "../../../app/routes/app.settings";
import { loader as programsLoader } from "../../../app/routes/app.trade_in_programs._index";
import { action as newProgramAction, loader as newProgramLoader } from "../../../app/routes/app.trade_in_programs.new";
import { action as programAction, loader as programLoader } from "../../../app/routes/app.trade_in_programs.$id";
import { loader as tradeInsLoader } from "../../../app/routes/app.trade_ins._index";
import { action as tradeInAction, loader as tradeInLoader } from "../../../app/routes/app.trade_ins.$id";
import {
  approveTradeIn,
  creditTradeIn,
  receiveTradeIn,
} from "../../../app/services/trade-ins/workflow.server";
import { flash, get, post, signInAs, statusOf } from "../../support/admin";
import { buildProgram, createItemFor, createShop, createTradeInFor, daysAgo } from "../../support/factories";

vi.mock("../../../app/services/trade-ins/workflow.server", () => ({
  approveTradeIn: vi.fn(),
  rejectTradeIn: vi.fn(),
  cancelTradeIn: vi.fn(),
  receiveTradeIn: vi.fn(),
  creditTradeIn: vi.fn(),
}));

async function setup(settings: Record<string, unknown> = { currency: "GBP", trade_in_enabled: true }) {
  const shop = await createShop({ shopifyDomain: "tradein-admin.myshopify.com", settings: settings as never });
  signInAs(shop);
  const program = await buildProgram(shop);
  const item = await createItemFor(shop, { shopifyCustomerId: "77", productTitle: "Aria Boot", purchasedAt: daysAgo(365) });
  return { shop, program, item };
}

const id = (n: number) => ({ id: String(n) });

describe("trade-in admin", () => {
  it("with the flag off, trade-in is hidden from the admin", async () => {
    await setup({ currency: "GBP" });
    expect((await get<{ tradeInEnabled: boolean }>(appLoader, "/app")).tradeInEnabled).toBe(false);
    for (const [loader, path] of [
      [tradeInsLoader, "/app/trade_ins"],
      [programsLoader, "/app/trade_in_programs"],
      [newProgramLoader, "/app/trade_in_programs/new"],
    ] as const) {
      expect(flash(await get(loader, path)).path).toBe("/app/tickets");
    }
    expect((await get<{ tradeIn: unknown }>(settingsLoader, "/app/settings")).tradeIn).toBeNull();
  });

  it("with the flag on, the nav shows Trade-ins", async () => {
    await setup();
    expect((await get<{ tradeInEnabled: boolean }>(appLoader, "/app")).tradeInEnabled).toBe(true);
  });

  it("programs and the trade-in queue render; approve and receive go through the workflow", async () => {
    const { shop, program, item } = await setup();
    const tradeIn = await createTradeInFor(shop, {
      tradeInProgramId: program.id,
      itemId: item.id,
      shopifyCustomerId: "77",
      declaredGrade: "good",
      quotedCredit: 25,
      currency: "GBP",
    });
    await createTradeInFor(shop, { productTitle: "Never bought", status: "pending_purchase", source: "pdp" });

    for (const [loader, path, params] of [
      [tradeInsLoader, "/app/trade_ins", {}],
      [tradeInsLoader, "/app/trade_ins?status=requested", {}],
      [tradeInLoader, `/app/trade_ins/${tradeIn.id}`, id(tradeIn.id)],
      [programsLoader, "/app/trade_in_programs", {}],
      [newProgramLoader, "/app/trade_in_programs/new", {}],
      [programLoader, `/app/trade_in_programs/${program.id}`, id(program.id)],
    ] as const) {
      expect(statusOf(await get(loader, path, params)), path).toBe(200);
    }
    const queue = await get<Awaited<ReturnType<typeof tradeInsLoader>>>(tradeInsLoader, "/app/trade_ins");
    expect(queue.tradeIns.map((t) => t.id)).toEqual([tradeIn.id]); // the unpaid product-page trade-in is hidden

    vi.mocked(approveTradeIn).mockResolvedValue(tradeIn);
    const approved = await post(tradeInAction, `/app/trade_ins/${tradeIn.id}`, { intent: "approve", note: "OK" }, id(tradeIn.id));
    expect(flash(approved).notice).toBe("Trade-in approved; the customer has been told how to send it.");
    expect(approveTradeIn).toHaveBeenCalledWith({ shopId: shop.id, tradeInId: tradeIn.id, note: "OK" });

    vi.mocked(receiveTradeIn).mockResolvedValue(tradeIn);
    vi.mocked(creditTradeIn).mockResolvedValue({ ...tradeIn, finalCredit: new (await import("@prisma/client")).Prisma.Decimal(40) });
    const received = await post(tradeInAction, `/app/trade_ins/${tradeIn.id}`, {
      intent: "receive",
      grade: "excellent",
      credit: "",
      credit_now: ["0", "1"],
    }, id(tradeIn.id));
    expect(receiveTradeIn).toHaveBeenCalledWith({ shopId: shop.id, tradeInId: tradeIn.id, note: null, grade: "excellent", credit: null });
    expect(flash(received).notice).toBe("Item received and £40.00 credited.");
  });

  it("a failed credit is shown, not raised", async () => {
    const { shop, program } = await setup();
    const tradeIn = await createTradeInFor(shop, {
      tradeInProgramId: program.id,
      status: "received",
      finalGrade: "good",
      finalCredit: 25,
      currency: "GBP",
    });
    vi.mocked(creditTradeIn).mockRejectedValue(new Error("Store credit isn't enabled"));
    const res = await post(tradeInAction, `/app/trade_ins/${tradeIn.id}`, { intent: "credit" }, id(tradeIn.id));
    expect(flash(res).alert).toBe("Store credit isn't enabled");
  });

  it("create a program; an in-use program is switched off, not deleted", async () => {
    const { shop, program } = await setup();
    const res = await post(newProgramAction, "/app/trade_in_programs/new", {
      name: "Footwear",
      credit_mode: "percent",
      max_age_months: "36",
      active: ["0", "1"],
      "grades[0][label]": "Good",
      "grades[0][description]": "",
      "grades[0][value]": "30",
      "grades[1][label]": "",
      "grades[1][value]": "",
      eligibility_mode: "product_type",
      eligibility_value: "Boots",
    });
    expect(flash(res).notice).toBe("Trade-in program created.");
    const created = await prisma.tradeInProgram.findFirstOrThrow({ where: { name: "Footwear" } });
    expect([created.creditMode, created.maxAgeMonths, (created.grades as unknown[]).length, created.eligibility]).toEqual([
      "percent", 36, 1, { mode: "product_type", value: "Boots" },
    ]);

    await createTradeInFor(shop, { tradeInProgramId: program.id });
    const deleted = await post(programAction, `/app/trade_in_programs/${program.id}`, { intent: "delete" }, id(program.id));
    expect(flash(deleted).notice).toBe("This program has trade-ins, so it's been switched off rather than deleted.");
    expect((await prisma.tradeInProgram.findUniqueOrThrow({ where: { id: program.id } })).active).toBe(false);
  });

  it("an invalid program re-renders with the messages", async () => {
    await setup();
    const res = await post(newProgramAction, "/app/trade_in_programs/new", { name: "X", "grades[0][label]": "" });
    expect(statusOf(res)).toBe(422);
  });

  it("another shop's trade-ins and programs are out of reach", async () => {
    await setup();
    const other = await createShop({ settings: { trade_in_enabled: true } });
    const theirProgram = await buildProgram(other);
    const theirs = await createTradeInFor(other, { tradeInProgramId: theirProgram.id });
    expect(statusOf(await get(tradeInLoader, `/app/trade_ins/${theirs.id}`, id(theirs.id)))).toBe(404);
    expect(statusOf(await post(tradeInAction, `/app/trade_ins/${theirs.id}`, { intent: "approve" }, id(theirs.id)))).toBe(404);
    expect(statusOf(await post(programAction, `/app/trade_in_programs/${theirProgram.id}`, { intent: "delete" }, id(theirProgram.id)))).toBe(404);
    expect(approveTradeIn).not.toHaveBeenCalledWith(expect.objectContaining({ tradeInId: theirs.id }));
  });
});
