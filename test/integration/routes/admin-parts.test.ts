/**
 * Workshop inventory: Rails admin_parts_test.rb and admin_part_imports_test.rb.
 * Completing a ticket (taking parts from stock) is changeTicketStatus
 * (w2-backend), mocked here.
 */
import { describe, expect, it, vi } from "vitest";
import prisma from "../../../app/db.server";
import { moveStock } from "../../../app/models/part-variant.server";
import { CSV_COLUMNS, MAX_BYTES } from "../../../app/services/parts/csv-import.server";
import { action as partsNewAction, loader as partsNewLoader } from "../../../app/routes/app.parts.new";
import { loader as partsLoader } from "../../../app/routes/app.parts._index";
import { action as partAction, loader as partLoader } from "../../../app/routes/app.parts.$id._index";
import { action as editAction, loader as editLoader } from "../../../app/routes/app.parts.$id.edit";
import { loader as reorderLoader } from "../../../app/routes/app.parts.reorder";
import { loader as exportLoader } from "../../../app/routes/app.parts.export";
import { loader as stockUsedLoader } from "../../../app/routes/app.parts.stock_used";
import { loader as templateLoader } from "../../../app/routes/app.parts.imports.template";
import { action as uploadAction, loader as uploadLoader } from "../../../app/routes/app.parts.imports.new";
import { action as applyAction, loader as previewLoader } from "../../../app/routes/app.parts.imports.$id";
import { action as ticketAction, loader as ticketLoader } from "../../../app/routes/app.tickets.$id";
import { loader as appLoader } from "../../../app/routes/app";
import { changeTicketStatus } from "../../../app/services/repairs/ticket-status.server";
import { dataOf, flash, get, post, signInAs, statusOf } from "../../support/admin";
import {
  buildWorkshop,
  createLineItem,
  createPartImportFor,
  createQuotationFor,
  createRepairTicketFor,
  createShop,
} from "../../support/factories";
import { FakeGraphql } from "../../support/fake-graphql";

vi.mock("../../../app/services/repairs/ticket-status.server", () => ({ changeTicketStatus: vi.fn() }));

async function setup(settings: Record<string, unknown> = { currency: "GBP", parts_enabled: true }) {
  const shop = await createShop({ shopifyDomain: "admin-parts.myshopify.com", settings: settings as never });
  signInAs(shop, {
    admin: new FakeGraphql({ "products(": { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
  });
  return { shop, workshop: await buildWorkshop(shop) };
}

const id = (n: number) => ({ id: String(n) });
const csv = (...rows: string[]) => [CSV_COLUMNS.join(","), ...rows].join("\n");
const upload = (text: string, name = "parts.csv") => new File([text], name, { type: "text/csv" });

describe("parts", () => {
  it("screens render, and the nav and page call it Workshop inventory", async () => {
    const { workshop } = await setup();
    const sole = workshop.sole.id;
    for (const [loader, path, params] of [
      [partsLoader, "/app/parts", {}],
      [partsLoader, "/app/parts?filter=low", {}],
      [partsNewLoader, "/app/parts/new", {}],
      [partLoader, `/app/parts/${sole}`, id(sole)],
      [editLoader, `/app/parts/${sole}/edit`, id(sole)],
      [reorderLoader, "/app/parts/reorder", {}],
    ] as const) {
      expect(statusOf(await get(loader, path, params)), path).toBe(200);
    }
    expect((await get<{ partsEnabled: boolean }>(appLoader, "/app")).partsEnabled).toBe(true);
    const list = await get<Awaited<ReturnType<typeof partsLoader>>>(partsLoader, "/app/parts?filter=low");
    expect(list.parts.map((p) => p.name)).toEqual(["Adhesive", "Commando sole"]);
    expect(list.lowCount).toBe(5);
  });

  it("reorder list downloads as CSV", async () => {
    await setup();
    const res = await get<Response>(reorderLoader, "/app/parts/reorder?format=csv");
    expect(res.headers.get("Content-Type")).toMatch(/^text\/csv/);
    expect(await res.text()).toContain("Commando sole");
    expect(res.headers.get("Content-Disposition")).toMatch(/filename="workshop-inventory-reorder-\d{4}-\d{2}-\d{2}\.csv"/);
  });

  it("create a part, add variants, receive in packs and count stock", async () => {
    const { shop } = await setup();
    const res = await post(partsNewAction, "/app/parts/new", {
      name: "Eyelets",
      unit: "each",
      pack_size: "100",
      cost_per_unit: "0.05",
      reorder_level: "50",
      reorder_quantity: "200",
      active: ["0", "1"],
      option_names: ["", "colour"],
    });
    const part = await prisma.part.findFirstOrThrow({ where: { shopId: shop.id, name: "Eyelets" } });
    expect(flash(res)).toEqual({ path: `/app/parts/${part.id}`, notice: "Part created. Now add its variants." });

    await post(partAction, `/app/parts/${part.id}`, { intent: "generate", "values[colour]": "Brass, Silver" }, id(part.id));
    const variants = await prisma.partVariant.findMany({ where: { partId: part.id }, orderBy: { id: "asc" } });
    expect(variants.map((v) => v.options)).toEqual([{ colour: "Brass" }, { colour: "Silver" }]);

    const brass = variants[0];
    const received = await post(partAction, `/app/parts/${part.id}`, {
      intent: "receive",
      variant_id: String(brass.id),
      quantity: "2",
      in: "packs",
    }, id(part.id));
    expect(flash(received).notice).toBe("Received 200 each of Brass.");
    const counted = await post(partAction, `/app/parts/${part.id}`, {
      intent: "adjust",
      variant_id: String(brass.id),
      counted: "180",
    }, id(part.id));
    expect(flash(counted).notice).toBe("Brass now 180 each.");
    const movements = await prisma.stockMovement.findMany({ where: { partVariantId: brass.id }, orderBy: { id: "asc" } });
    expect(movements.map((m) => m.reason)).toEqual(["received", "adjusted"]);
    expect(flash(await post(partAction, `/app/parts/${part.id}`, { intent: "receive", variant_id: String(brass.id), quantity: "" }, id(part.id))).alert).toBe(
      "Enter how much arrived.",
    );
    expect(flash(await post(partAction, `/app/parts/${part.id}`, { intent: "delete_variant", variant_id: String(brass.id) }, id(part.id))).alert).toBe(
      "This variant has stock history, so it can't be deleted.",
    );
  });

  it("options can't change once variants have stock history", async () => {
    const { workshop } = await setup();
    const sole = workshop.sole;
    const first = await prisma.partVariant.findFirstOrThrow({ where: { partId: sole.id }, orderBy: { id: "asc" } });
    await moveStock(first.id, 1, { reason: "received" });

    const res = await post(editAction, `/app/parts/${sole.id}/edit`, {
      name: "Sole",
      unit: "pair",
      option_names: ["", "size"],
    }, id(sole.id));

    expect(statusOf(res)).toBe(422);
    expect(dataOf<{ errors: string[] }>(res).errors).toEqual(["Option names can't change once the part's variants have stock history"]);
    expect((await prisma.part.findUniqueOrThrow({ where: { id: sole.id } })).optionNames).toEqual(["model", "size"]);
  });

  it("a part used on repairs can't be deleted", async () => {
    const { shop, workshop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    await prisma.ticketPart.create({ data: { repairTicketId: ticket.id, partId: workshop.glue.id, quantity: 1 } });
    const res = await post(editAction, `/app/parts/${workshop.glue.id}/edit`, { intent: "delete" }, id(workshop.glue.id));
    expect(flash(res).alert).toMatch(/can't be deleted/);
    const unused = await post(editAction, `/app/parts/${workshop.sole.id}/edit`, { intent: "delete" }, id(workshop.sole.id));
    expect(flash(unused)).toEqual({ path: "/app/parts", notice: "Part deleted." });
  });

  it("plan parts on a ticket, choose a variant, and complete it through the status service", async () => {
    const { shop, workshop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    const quote = await createQuotationFor(ticket.id, { status: "paid" });
    await createLineItem(quote.id, { kind: "repair", title: "Resole", unitPrice: 60, shopifyVariantId: "900" });
    const act = (fields: Record<string, string>) => post(ticketAction, `/app/tickets/${ticket.id}`, fields, id(ticket.id));

    expect(flash(await act({ intent: "plan_parts" })).notice).toBe(
      "2 parts planned from the quote's services. Choose a variant for 1.",
    );
    const soleLine = await prisma.ticketPart.findFirstOrThrow({ where: { partId: workshop.sole.id } });
    expect(soleLine.partVariantId).toBeNull();

    const detail = await get<Awaited<ReturnType<typeof ticketLoader>>>(ticketLoader, `/app/tickets/${ticket.id}`, id(ticket.id));
    expect(detail.ticketParts.find((tp) => tp.id === soleLine.id)?.variantId).toBeNull();

    const chosen = await prisma.partVariant.findFirstOrThrow({ where: { partId: workshop.sole.id }, orderBy: { id: "desc" } });
    expect(flash(await act({ intent: "update_part", ticket_part_id: String(soleLine.id), part_variant_id: String(chosen.id) })).notice).toBe(
      "Part updated.",
    );
    expect((await prisma.ticketPart.findUniqueOrThrow({ where: { id: soleLine.id } })).partVariantId).toBe(chosen.id);

    vi.mocked(changeTicketStatus).mockResolvedValue({ ok: true, changed: true, message: "Status updated to completed. 2 parts taken from stock." });
    expect(flash(await act({ intent: "status", status: "completed" })).notice).toBe(
      "Status updated to completed. 2 parts taken from stock.",
    );

    await prisma.repairTicket.update({
      where: { id: ticket.id },
      data: { status: "completed", costs: { price: "60.0", parts: "12.6", labour: "30.0", labour_minutes: 45, margin: "17.4", currency: "GBP" } },
    });
    const after = await get<Awaited<ReturnType<typeof ticketLoader>>>(ticketLoader, `/app/tickets/${ticket.id}`, id(ticket.id));
    expect(after.costs?.margin).toBe("£17.40");
  });

  it("parts added by hand; a used part can't be changed or removed", async () => {
    const { shop, workshop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    const act = (fields: Record<string, string>) => post(ticketAction, `/app/tickets/${ticket.id}`, fields, id(ticket.id));
    expect(flash(await act({ intent: "add_part", part_id: String(workshop.glue.id), quantity: "5" })).notice).toBe("Adhesive added.");
    const line = await prisma.ticketPart.findFirstOrThrow();
    expect(line.partVariantId).not.toBeNull(); // a part with no options uses its only variant
    await prisma.ticketPart.update({ where: { id: line.id }, data: { consumedAt: new Date() } });
    expect(flash(await act({ intent: "update_part", ticket_part_id: String(line.id), quantity: "2" })).alert).toBe(
      "That part has already been used.",
    );
    expect(flash(await act({ intent: "remove_part", ticket_part_id: String(line.id) })).alert).toBe(
      "That part has already been taken from stock.",
    );
  });

  it("with parts switched off, the screens redirect home and ticket parts are hidden", async () => {
    const { shop, workshop } = await setup({ currency: "GBP", parts_enabled: false });
    const ticket = await createRepairTicketFor(shop);
    for (const [loader, path, params] of [
      [partsLoader, "/app/parts", {}],
      [partLoader, `/app/parts/${workshop.sole.id}`, id(workshop.sole.id)],
      [reorderLoader, "/app/parts/reorder", {}],
      [uploadLoader, "/app/parts/imports/new", {}],
      [exportLoader, "/app/parts/export", {}],
      [stockUsedLoader, "/app/parts/stock_used", {}],
    ] as const) {
      expect(flash(await get(loader, path, params)).path, path).toBe("/app/tickets");
    }
    expect(flash(await post(ticketAction, `/app/tickets/${ticket.id}`, { intent: "plan_parts" }, id(ticket.id))).path).toBe("/app/tickets");
    const detail = await get<Awaited<ReturnType<typeof ticketLoader>>>(ticketLoader, `/app/tickets/${ticket.id}`, id(ticket.id));
    expect([detail.partsEnabled, detail.ticketParts]).toEqual([false, []]);
    expect((await get<{ partsEnabled: boolean }>(appLoader, "/app")).partsEnabled).toBe(false);
  });

  it("another shop's parts, variants and ticket parts are out of reach", async () => {
    const { shop } = await setup();
    const other = await createShop({ settings: { parts_enabled: true } });
    const theirs = await buildWorkshop(other);
    const mine = await createRepairTicketFor(shop);
    expect(statusOf(await get(partLoader, `/app/parts/${theirs.sole.id}`, id(theirs.sole.id)))).toBe(404);
    expect(statusOf(await post(editAction, `/app/parts/${theirs.glue.id}/edit`, { intent: "delete" }, id(theirs.glue.id)))).toBe(404);
    expect(statusOf(await post(ticketAction, `/app/tickets/${mine.id}`, { intent: "add_part", part_id: String(theirs.glue.id) }, id(mine.id)))).toBe(404);
    const list = await get<Awaited<ReturnType<typeof partsLoader>>>(partsLoader, "/app/parts");
    expect(list.parts).toHaveLength(2);
    expect(await prisma.part.count()).toBe(4);
  });
});

describe("part imports", () => {
  it("upload, preview, then apply a stock count", async () => {
    const { shop, workshop } = await setup();
    expect(statusOf(await get(uploadLoader, "/app/parts/imports/new"))).toBe(200);

    const res = await post(uploadAction, "/app/parts/imports/new", {
      mode: "stock",
      file: upload(csv("Adhesive,,,,,,,,,,,900", "Eyelets,EYE,each,,,,,,,,,")),
    });
    const record = await prisma.partImport.findFirstOrThrow({ where: { shopId: shop.id } });
    expect(flash(res).path).toBe(`/app/parts/imports/${record.id}`);
    expect(await prisma.stockMovement.count()).toBe(0);

    const preview = await get<Awaited<ReturnType<typeof previewLoader>>>(previewLoader, `/app/parts/imports/${record.id}`, id(record.id));
    expect(preview.stockChanges.map((c) => c.change)).toEqual(["+900"]);
    expect(preview.canApply).toBe(true);

    const applied = await post(applyAction, `/app/parts/imports/${record.id}`, {}, id(record.id));
    expect(flash(applied)).toEqual({
      path: "/app/parts",
      notice: "Imported: 1 part and 1 variant added or updated, 1 stock count set.",
    });
    const glue = await prisma.partVariant.findFirstOrThrow({ where: { partId: workshop.glue.id } });
    expect(glue.onHand.toNumber()).toBe(900);
    expect(await prisma.part.count({ where: { sku: "EYE" } })).toBe(1);
    expect((await prisma.partImport.findUniqueOrThrow({ where: { id: record.id } })).appliedAt).not.toBeNull();

    const again = await post(applyAction, `/app/parts/imports/${record.id}`, {}, id(record.id));
    expect(flash(again).notice).toBe("That import was already applied.");
    expect(await prisma.stockMovement.count()).toBe(1);
  });

  it("a file with errors shows them and can't be applied", async () => {
    const { shop } = await setup();
    await post(uploadAction, "/app/parts/imports/new", { mode: "parts", file: upload(csv("Eyelets,,box,,,,,,,,,")) });
    const record = await prisma.partImport.findFirstOrThrow({ where: { shopId: shop.id } });
    const preview = await get<Awaited<ReturnType<typeof previewLoader>>>(previewLoader, `/app/parts/imports/${record.id}`, id(record.id));
    expect(preview.errors.map((e) => e.message)).toEqual(["Unknown unit “box”. Use each, pair, metre, ml or g."]);
    expect(preview.canApply).toBe(false);

    const res = await post(applyAction, `/app/parts/imports/${record.id}`, {}, id(record.id));
    expect(statusOf(res)).toBe(422);
    expect(dataOf<{ alert: string }>(res).alert).toBe("Nothing was imported: The file has 1 error.");
    expect(await prisma.part.count({ where: { name: "Eyelets" } })).toBe(0);
    expect((await prisma.partImport.findUniqueOrThrow({ where: { id: record.id } })).appliedAt).toBeNull();
  });

  it("rejects a missing or oversized file", async () => {
    await setup();
    expect(flash(await post(uploadAction, "/app/parts/imports/new", { mode: "parts" }))).toEqual({
      path: "/app/parts/imports/new",
      alert: "Choose a CSV file to import.",
    });
    const big = await post(uploadAction, "/app/parts/imports/new", { mode: "parts", file: upload("x".repeat(MAX_BYTES + 1)) });
    expect(flash(big).alert).toBe("That file is over 2 MB.");
    expect(await prisma.partImport.count()).toBe(0);
  });

  it("another shop's import can't be seen or applied", async () => {
    await setup();
    const other = await createShop();
    const theirs = await createPartImportFor(other, { csvData: csv("Laces,,,,,,,,,,,") });
    expect(statusOf(await get(previewLoader, `/app/parts/imports/${theirs.id}`, id(theirs.id)))).toBe(404);
    expect(statusOf(await post(applyAction, `/app/parts/imports/${theirs.id}`, {}, id(theirs.id)))).toBe(404);
    expect(await prisma.part.count({ where: { name: "Laces" } })).toBe(0);
  });

  it("template, parts export and stock used download as CSV", async () => {
    const { workshop } = await setup();
    const glue = await prisma.partVariant.findFirstOrThrow({ where: { partId: workshop.glue.id } });
    await moveStock(glue.id, 500, { reason: "received" });

    const template = await get<Response>(templateLoader, "/app/parts/imports/template");
    expect(template.headers.get("Content-Type")).toMatch(/^text\/csv/);
    expect((await template.text()).startsWith(CSV_COLUMNS.join(","))).toBe(true);
    expect(template.headers.get("Content-Disposition")).toContain('filename="workshop-inventory-template.csv"');

    const exported = await get<Response>(exportLoader, "/app/parts/export");
    expect(await exported.text()).toContain("Adhesive,,ml,500,0.02,200,0,,,,,500");
    expect(exported.headers.get("Content-Disposition")).toMatch(/filename="workshop-inventory-\d{4}-\d{2}-\d{2}\.csv"/);

    const today = new Date().toISOString().slice(0, 10);
    const used = await get<Response>(stockUsedLoader, `/app/parts/stock_used?from=${today}&to=not-a-date`);
    expect(await used.text()).toContain("Adhesive,,Standard,,500,ml,received");
    expect(used.headers.get("Content-Disposition")).toMatch(/filename="workshop-inventory-used-[\d-]+-to-[\d-]+\.csv"/);
  });
});
