/** Port of Rails test/services/parts/csv_import_test.rb (import + export). */
import { beforeEach, describe, expect, it, vi } from "vitest";

const failMove = vi.hoisted(() => ({ on: false }));
vi.mock("../../../../app/models/part-variant.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../app/models/part-variant.server")>();
  return {
    ...original,
    moveStock: (...args: Parameters<typeof original.moveStock>) =>
      failMove.on ? Promise.reject(new Error("boom")) : original.moveStock(...args),
  };
});
import type { Shop } from "@prisma/client";
import prisma from "../../../../app/db.server";
import { parseCsv } from "../../../../app/lib/csv";
import { moveStock, variantMatches } from "../../../../app/models/part-variant.server";
import { exportParts, exportStockUsed } from "../../../../app/services/parts/csv-export.server";
import { CSV_COLUMNS, CsvImport, InvalidImportError } from "../../../../app/services/parts/csv-import.server";
import { buildWorkshop, createRepairTicketFor, createShop } from "../../../support/factories";

const HEADER = CSV_COLUMNS.join(",");
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

let shop: Shop;
let sole: Awaited<ReturnType<typeof buildWorkshop>>["sole"];
let glue: Awaited<ReturnType<typeof buildWorkshop>>["glue"];

beforeEach(async () => {
  shop = await createShop({ shopifyDomain: "csv-import.myshopify.com", settings: { parts_enabled: true } });
  const workshop = await buildWorkshop(shop);
  sole = await prisma.part.update({ where: { id: workshop.sole.id }, data: { sku: "SOLE" } });
  glue = workshop.glue;
  const first = await prisma.partVariant.findFirstOrThrow({ where: { partId: sole.id }, orderBy: { id: "asc" } });
  await prisma.partVariant.update({ where: { id: first.id }, data: { sku: "SOLE-CMD-7" } });
});

const build = (text: string | Uint8Array, mode = "parts", s: Shop = shop) =>
  CsvImport.build(s.id, text, { mode, filename: "stock.csv" });
const messages = (importer: CsvImport) => importer.errors.map((e) => [e.row, e.message]);
const variantsOf = (partId: number) => prisma.partVariant.findMany({ where: { partId }, orderBy: { id: "asc" } });
const counts = async () => (await prisma.part.count()) + (await prisma.partVariant.count()) + (await prisma.stockMovement.count());

describe("CsvImport", () => {
  it("previews new and updated parts and variants without writing anything", async () => {
    const importer = await build(
      csv(
        "Commando sole,SOLE,pair,1,13,2,10,Commando,UK 7,,SOLE-CMD-7,",
        "Commando sole,SOLE,,,,,,Commando,UK 9,,SOLE-CMD-9,",
        "Eyelets,EYE,each,100,0.05,50,200,,,,,",
      ),
    );
    expect(importer.valid, JSON.stringify(messages(importer))).toBe(true);
    expect(importer.summary()).toEqual({
      rows: 3, parts_created: 1, parts_updated: 1, variants_created: 2, variants_updated: 0, stock_changes: 0, errors: 0,
    });
    const before = await counts();
    (await build(csv("Eyelets,EYE,each,100,0.05,50,200,,,,,"))).summary();
    expect(await counts()).toBe(before);
    expect((await prisma.part.findUniqueOrThrow({ where: { id: sole.id } })).costPerUnit.toNumber()).toBe(12);
  });

  it("add/update mode writes parts and variants but leaves stock alone", async () => {
    const text = csv(
      "Commando sole,SOLE,pair,1,13,2,10,Commando,UK 7,,SOLE-CMD-7,99",
      "Commando sole,SOLE,,,,,,Commando,UK 9,,SOLE-CMD-9,5",
      "Eyelets,EYE,ea,100,£0.05,50,200,,,,EYE-1,7",
    );
    await (await build(text)).apply({ by: "staff" });

    expect(await prisma.stockMovement.count()).toBe(0);
    expect((await prisma.part.findUniqueOrThrow({ where: { id: sole.id } })).costPerUnit.toNumber()).toBe(13);
    const uk9 = (await variantsOf(sole.id)).find((v) => variantMatches(v, "size", "UK 9"))!;
    expect([uk9.sku, uk9.onHand.toNumber()]).toEqual(["SOLE-CMD-9", 0]);
    const eyelets = await prisma.part.findFirstOrThrow({ where: { sku: "EYE" }, include: { variants: true } });
    expect([eyelets.unit, eyelets.packSize.toNumber(), eyelets.costPerUnit.toString(), eyelets.optionNames]).toEqual([
      "each", 100, "0.05", [],
    ]);
    expect(eyelets.variants.map((v) => v.sku)).toEqual(["EYE-1"]);
    expect((await variantsOf(sole.id))[0].onHand.toNumber()).toBe(0);
  });

  it("stock mode sets on-hand and records the difference as a stock count", async () => {
    const [uk7] = await variantsOf(sole.id);
    await moveStock(uk7.id, 4, { reason: "received" });

    const importer = await build(
      csv("Commando sole,SOLE,,,,,,Commando,UK 7,,,10", "Commando sole,SOLE,,,,,,Commando,UK 8,,,", "Adhesive,,,,,,,,,,,750"),
      "stock",
    );
    expect(importer.stockChanges.map((c) => [c.partName, c.variantLabel, c.from.toNumber(), c.to.toNumber()])).toEqual([
      ["Commando sole", "Commando · UK 7", 4, 10],
      ["Adhesive", "Standard", 0, 750],
    ]);
    await importer.apply({ by: "staff" });

    expect((await prisma.partVariant.findUniqueOrThrow({ where: { id: uk7.id } })).onHand.toNumber()).toBe(10);
    const movement = await prisma.stockMovement.findFirstOrThrow({ where: { partVariantId: uk7.id }, orderBy: { id: "desc" } });
    expect([movement.reason, movement.quantity.toNumber(), movement.note, movement.createdBy]).toEqual([
      "stock_count", 6, "Stock count from stock.csv", "staff",
    ]);
    expect((await variantsOf(glue.id))[0].onHand.toNumber()).toBe(750);
    const uk8 = (await variantsOf(sole.id)).find((v) => variantMatches(v, "model", "Commando") && variantMatches(v, "size", "UK 8"))!;
    expect(await prisma.stockMovement.count({ where: { partVariantId: uk8.id } })).toBe(0);
  });

  it("matches parts by name and variants by options, loosely", async () => {
    const importer = await build(csv("  commando SOLE ,,,,,,,commando,uk 7,,,3"), "stock");
    expect(importer.valid, JSON.stringify(messages(importer))).toBe(true);
    const s = importer.summary();
    expect([s.parts_created, s.variants_created, s.stock_changes]).toEqual([0, 0, 1]);
  });

  it("reports row errors: unit, numbers, options and duplicates", async () => {
    const importer = await build(
      csv(
        "Commando sole,SOLE,box,,,,,Commando,UK 7,,,",
        "Commando sole,SOLE,,abc,,,,Commando,UK 8,Black,,",
        "Commando sole,SOLE,,,,,,Commando,,,,",
        "Eyelets,,each,0,,,,,,,,",
        "Commando sole,SOLE,,,,,,Commando,UK 7,,,",
        ",,,,,,,,,,,1",
        "Adhesive,,,,,,,,,,SOLE-CMD-7,",
        "Laces,,each,1,-2,,,,,,,",
      ),
      "stock",
    );
    expect(importer.valid).toBe(false);
    expect(messages(importer)).toEqual([
      [2, "Unknown unit “box”. Use each, pair, metre, ml or g."],
      [3, "pack_size “abc” isn't a number."],
      [5, "pack_size must be more than 0."],
      [7, "Needs a part_name or part_sku."],
      [9, "cost_per_unit must be at least 0."],
      [3, "Commando sole varies by model, size, so colour can't be set."],
      [4, "Commando sole needs a size on every row."],
      [6, "Same Commando sole variant as row 2."],
      [8, "variant_sku “SOLE-CMD-7” already belongs to Commando sole (Commando · UK 7)."],
    ]);
    await expect(importer.apply()).rejects.toThrow(InvalidImportError);
  });

  it("a new variant_sku can only be used once, and part fields must agree", async () => {
    const importer = await build(csv("Laces,LACE,each,1,0.5,,,,Black,,LACE-1,", "Laces,LACE,each,1,0.6,,,,Brown,,LACE-1,"));
    expect(messages(importer)).toEqual([
      [3, "cost_per_unit for Laces differs from row 2."],
      [3, "variant_sku “LACE-1” is also on row 2."],
    ]);
  });

  it("file-level problems: missing column, too many rows, not a CSV, unknown mode", async () => {
    expect(messages(await build("name,sku\nSole,S"))).toEqual([
      [null, "The file has no part_name column. Download the template to see the columns."],
    ]);
    expect(messages(await build(HEADER))).toEqual([[null, "The file has no rows."]]);
    const tooMany = await CsvImport.build(shop.id, csv("A,,,,,,,,,,,", "B,,,,,,,,,,,", "C,,,,,,,,,,,"), { mode: "parts", maxRows: 2 });
    expect(tooMany.errors[0].message).toMatch(/more than 2 rows/);
    expect((await build('part_name\n"unclosed')).errors[0].message).toMatch(/doesn't look like a CSV/);
    expect((await build(csv("A,,,,,,,,,,,"), "nope")).errors[0].message).toMatch(/Choose how/);
  });

  it("reads Excel files: byte-order mark, semicolons, decimal commas, Windows-1252", async () => {
    const text = `${CSV_COLUMNS.join(";")}\nSemelle crêpe;CREPE;pair;1;12,5;;;;;;;\n`;
    const windows1252 = Uint8Array.from(Array.from(text, (ch) => (ch === "ê" ? 0xea : ch.charCodeAt(0))));
    const importer = await build(windows1252);
    expect(importer.valid, JSON.stringify(messages(importer))).toBe(true);
    await importer.apply();
    const part = await prisma.part.findFirstOrThrow({ where: { sku: "CREPE" } });
    expect([part.name, part.costPerUnit.toNumber()]).toEqual(["Semelle crêpe", 12.5]);

    const bom = await build(new TextEncoder().encode(`\uFEFF${csv("Laces,LACE,each,,,,,,,,,")}`));
    expect(bom.valid, JSON.stringify(messages(bom))).toBe(true);
  });

  it("only touches this shop's parts", async () => {
    const other = await createShop({ shopifyDomain: "other-csv.myshopify.com" });
    const theirs = await prisma.part.create({ data: { shopId: other.id, name: "Commando sole", sku: "SOLE", unit: "pair" } });

    await (await build(csv("Commando sole,SOLE,,,99,,,Commando,UK 7,,,"), "stock")).apply();

    expect((await prisma.part.findUniqueOrThrow({ where: { id: sole.id } })).costPerUnit.toNumber()).toBe(99);
    expect((await prisma.part.findUniqueOrThrow({ where: { id: theirs.id } })).costPerUnit.toNumber()).toBe(0);
    const theirImport = await build(csv("Commando sole,SOLE,,,,,,Commando,UK 7,,,"), "parts", other);
    expect(theirImport.errors).toHaveLength(1); // the other shop's part has no model option
  });

  it("a failed write rolls the whole import back", async () => {
    failMove.on = true;
    const before = await prisma.part.count();
    await expect(
      (await build(csv("Eyelets,EYE,each,,,,,,,,,", "Commando sole,SOLE,,,,,,Commando,UK 7,,,5"), "stock")).apply(),
    ).rejects.toThrow("boom");
    expect(await prisma.part.count()).toBe(before);
    failMove.on = false;
  });

  it("the export imports back unchanged, and lists stock used between dates", async () => {
    const [first] = await variantsOf(sole.id);
    await moveStock(first.id, 3, { reason: "received" });
    const exported = await exportParts(shop.id);

    const roundTrip = await build(exported, "stock");
    expect(roundTrip.valid, JSON.stringify(messages(roundTrip))).toBe(true);
    const s = roundTrip.summary();
    expect([s.parts_created, s.parts_updated, s.variants_created, s.variants_updated, s.stock_changes]).toEqual([0, 0, 0, 0, 0]);
    expect(exported).toContain("Commando sole,SOLE,pair,1,12,2,10,Commando,UK 7,,SOLE-CMD-7,3");

    const ticket = await createRepairTicketFor(shop, { status: "completed" });
    await moveStock(first.id, -1, { reason: "consumed", repairTicketId: ticket.id });
    const later = await moveStock(first.id, -1, { reason: "consumed" });
    await prisma.stockMovement.update({ where: { id: later.id }, data: { createdAt: new Date(Date.now() + 3 * 86_400_000) } });

    const today = new Date();
    const [header, ...rows] = parseCsv(await exportStockUsed(shop.id, { from: today, to: today }));
    const col = (name: string) => header.indexOf(name);
    expect(rows.map((r) => [r[col("reason")], r[col("quantity")], r[col("ticket")]])).toEqual([
      ["received", "3", ""],
      ["consumed", "-1", `#${ticket.id}`],
    ]);
    expect(rows[0][col("date")]).toBe(today.toISOString().slice(0, 10));
  });
});
