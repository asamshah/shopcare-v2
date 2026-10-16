import { PDFDocument } from "pdf-lib";
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import {
  PAGE_HEIGHT,
  PAGE_WIDTH,
  printable,
  renderPostageSlip,
  slipDate,
  type PostageSlipInput,
} from "../../../app/lib/pdf/postage-slip-pdf";

const input = (overrides: Partial<PostageSlipInput> = {}): PostageSlipInput => ({
  storeName: "Acme Boots",
  ticketNumber: 1042,
  workshop: ["Acme Repairs", "4 Cobbler's Yard", "Northampton NN1 1AA", "United Kingdom"],
  customer: {
    name: "Sarah Jones",
    email: "sarah@example.com",
    addressLines: ["12 Bow Lane", "London EC4M 9EU", "United Kingdom"],
  },
  product: "Chelsea Boot",
  variant: "UK 7",
  repair: { heading: "Repairs quoted", lines: ["Sole replacement × 1", "Heel block × 2"] },
  date: new Date("2026-10-16T09:30:00Z"),
  qrUrl: "https://admin.shopify.com/store/acme/apps/shopcare/app/tickets/1042",
  instructions: "Pack your item securely and use a tracked service. Put the packing slip inside the parcel.",
  ...overrides,
});

const textsIn = (slip: Awaited<ReturnType<typeof renderPostageSlip>>, region: string) =>
  slip.texts.filter((t) => t.region === region).map((t) => t.text);

describe("renderPostageSlip", () => {
  it("is a one-page A4 PDF with the repair in its metadata", async () => {
    const slip = await renderPostageSlip(input());
    expect(Buffer.from(slip.pdf.slice(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(slip.pdf, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect([width, height]).toEqual([PAGE_WIDTH, PAGE_HEIGHT]);
    expect(doc.getTitle()).toBe("Repair #1042 postage slip");
    expect(doc.getCreator()).toBe("ShopCare");
    expect(doc.getCreationDate()?.toISOString()).toBe("2026-10-16T09:30:00.000Z");
    // Both fonts embedded (subset), under fixed names.
    const raw = Buffer.from(slip.pdf).toString("latin1");
    expect(raw).toContain("/BaseFont /ShopCareSans");
    expect(raw).toContain("/BaseFont /ShopCareSans-Bold");
  });

  it("prints the label: the workshop large, the customer's return address and the repair number", async () => {
    const slip = await renderPostageSlip(input());
    const label = textsIn(slip, "label");
    expect(label).toEqual([
      "TO:",
      "Acme Repairs",
      "4 Cobbler's Yard",
      "Northampton NN1 1AA",
      "United Kingdom",
      "REPAIR #1042",
      "FROM:",
      "Sarah Jones",
      "12 Bow Lane",
      "London EC4M 9EU",
      "United Kingdom",
      "Cut out this label and stick it on the outside of your parcel.",
    ]);
    const size = (text: string) => slip.texts.find((t) => t.region === "label" && t.text === text)!.size;
    expect(size("Acme Repairs")).toBeGreaterThanOrEqual(16);
    expect(size("REPAIR #1042")).toBe(26);
    expect(size("12 Bow Lane")).toBeLessThan(10);
  });

  it("prints the packing slip and the posting instructions", async () => {
    const slip = await renderPostageSlip(input());
    expect(textsIn(slip, "slip")).toEqual(
      expect.arrayContaining([
        "PACKING SLIP",
        "Acme Boots",
        "REPAIR #1042",
        "16 Oct 2026",
        "Customer",
        "Sarah Jones",
        "sarah@example.com",
        "12 Bow Lane, London EC4M 9EU, United Kingdom",
        "Chelsea Boot · UK 7",
        "Repairs quoted",
        "Sole replacement × 1",
        "Heel block × 2",
      ]),
    );
    expect(textsIn(slip, "instructions").join(" ")).toBe(
      "How to send your item Pack your item securely and use a tracked service. Put the packing slip inside the parcel.",
    );
  });

  it("encodes the admin ticket URL in the QR code, on the packing slip half", async () => {
    const slip = await renderPostageSlip(input());
    expect(slip.qr.payload).toBe("https://admin.shopify.com/store/acme/apps/shopcare/app/tickets/1042");
    expect(slip.qr.modules).toBe(QRCode.create(slip.qr.payload, { errorCorrectionLevel: "M" }).modules.size);
    const cut = slip.texts.find((t) => t.text.startsWith("Cut here"))!;
    expect(slip.qr.y + slip.qr.size).toBeLessThan(cut.y);
    expect(slip.qr.x + slip.qr.size).toBeLessThanOrEqual(PAGE_WIDTH - 36 + 0.01);
  });

  it("is deterministic: the same input gives the same bytes", async () => {
    const [a, b] = await Promise.all([renderPostageSlip(input()), renderPostageSlip(input())]);
    expect(Buffer.from(a.pdf).equals(Buffer.from(b.pdf))).toBe(true);
    const c = await renderPostageSlip(input({ ticketNumber: 1043 }));
    expect(Buffer.from(a.pdf).equals(Buffer.from(c.pdf))).toBe(false);
  });

  it("wraps and shrinks a long workshop address to fit the label", async () => {
    const long = "The Very Long Named Footwear Restoration and Resoling Workshop of Northamptonshire";
    const slip = await renderPostageSlip(
      input({
        workshop: [long, "Units 14–16, The Old Cordwainers' Industrial Estate, Off Long Street", "Kettering NN16 0AA", "United Kingdom"],
      }),
    );
    const workshop = slip.texts.filter((t) => t.region === "label" && t.bold && !["TO:", "FROM:", "REPAIR #1042"].includes(t.text));
    expect(workshop.length).toBeGreaterThan(4); // wrapped
    expect(workshop[0].size).toBeLessThan(19); // shrunk
    expect(workshop.map((t) => t.text).join(" ")).toContain("Northamptonshire");
    // Nothing spills out of the label: everything sits above "REPAIR #1042".
    const ticket = slip.texts.find((t) => t.region === "label" && t.text === "REPAIR #1042")!;
    for (const line of workshop) expect(line.y).toBeGreaterThan(ticket.y + ticket.size);
  });

  it("cuts a very long description off with an ellipsis above the footer", async () => {
    const essay = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const slip = await renderPostageSlip(input({ repair: { heading: "What you told us", lines: [essay] } }));
    const repair = slip.texts.filter((t) => t.region === "slip" && t.text.startsWith("word"));
    expect(repair.at(-1)!.text.endsWith("…")).toBe(true);
    expect(Math.min(...slip.texts.filter((t) => t.region === "slip").map((t) => t.y))).toBeGreaterThan(36);
  });

  it("draws Latin Extended text and turns what the font lacks into ?, without failing", async () => {
    const slip = await renderPostageSlip(
      input({
        customer: { name: "Zoë Łukasiewicz-Øvergaard", email: "zoe@example.com", addressLines: ["Ősz utca 3", "Kraków"] },
        product: "Георгий 東京 boot 🎉",
      }),
    );
    expect(textsIn(slip, "label")).toContain("Zoë Łukasiewicz-Øvergaard");
    expect(textsIn(slip, "slip")).toContain("??????? ?? boot ? · UK 7");
  });

  it("copes with a missing return address and an empty repair", async () => {
    const slip = await renderPostageSlip(
      input({ customer: { name: "", email: "", addressLines: [] }, repair: { heading: "", lines: [] } }),
    );
    expect(textsIn(slip, "label")).toContain("(your name and address)");
    expect(textsIn(slip, "slip")).toEqual(expect.arrayContaining(["Repair", "—"]));
  });
});

describe("printable / slipDate", () => {
  it("collapses whitespace and control characters into single spaces", () => {
    expect(printable("  a\n\tb\u0007c  ", new Set([..."abc "].map((c) => c.codePointAt(0)!)))).toBe("a b c");
  });

  it("formats the date in UTC", () => {
    expect(slipDate(new Date("2026-01-05T23:30:00Z"))).toBe("5 Jan 2026");
  });
});
