/**
 * The postage slip PDF: one A4 page the customer prints when they post their
 * item to the workshop. Pure (no database, storage or network), so it runs
 * the same in a Netlify Function, a test or a script.
 *
 *   (a) an address label to cut out and stick on the parcel: "To:" the
 *       workshop in large type, "From:" the customer's return address and
 *       the repair number;
 *   (b) a packing slip that goes inside the parcel: store name, repair
 *       number, date, customer, product, what's being repaired and a QR code
 *       that opens the ticket in the ShopCare admin;
 *   (c) the merchant's posting instructions, beside the label.
 *
 * Monochrome and printer-friendly (black, one grey, no fills). Long text is
 * wrapped and shrunk to fit its box, then cut with "…" at the smallest size.
 *
 * Fonts: Noto Sans Regular/Bold cut down to Latin (fonts/noto-sans.ts),
 * subset again into the PDF. Characters outside it (Greek, Cyrillic, CJK,
 * emoji, …) are printed as "?" rather than failing.
 *
 * Deterministic: the same input gives the same bytes (fixed font names, the
 * document dates set from `input.date`), so tests can compare output.
 */
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { NOTO_SANS_BOLD, NOTO_SANS_REGULAR } from "./fonts/noto-sans";

export interface PostageSlipInput {
  storeName: string;
  ticketNumber: number | string;
  /** The workshop address, one line per entry. */
  workshop: string[];
  customer: { name: string; email: string; addressLines: string[] };
  product: string;
  variant?: string | null;
  /** What's being repaired: the quote's lines, or the customer's description. */
  repair: { heading: string; lines: string[] };
  /** Printed on the slip (and the document's dates). */
  date: Date;
  /** Encoded in the QR code: the ticket in the ShopCare admin. */
  qrUrl: string;
  /** Settings → Repairs → Posting instructions. */
  instructions: string;
}

/** A piece of text as drawn, for tests (PDF text is glyph ids, not easy to read back). */
export interface DrawnText {
  text: string;
  x: number;
  y: number;
  size: number;
  bold: boolean;
  /** Which part of the page: "label", "instructions", "slip" or "page". */
  region: string;
}

export interface PostageSlip {
  pdf: Uint8Array;
  texts: DrawnText[];
  qr: { payload: string; x: number; y: number; size: number; modules: number };
}

// A4 in points.
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;
const MARGIN = 36;
const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.38, 0.38, 0.38);
const DASH = [4, 3];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "16 Oct 2026" (UTC). */
export function slipDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  /** Code points both fonts can draw. */
  charset: Set<number>;
}

/**
 * One line of printable text: control characters and runs of whitespace
 * become one space, and anything the font can't draw becomes "?".
 */
export function printable(value: string | null | undefined, charset: Set<number>): string {
  return Array.from(
    String(value ?? "")
      .normalize("NFC")
      .replace(/[\s\p{Cc}]+/gu, " ")
      .trim(),
  )
    .map((char) => (charset.has(char.codePointAt(0)!) ? char : "?"))
    .join("");
}

/** Breaks text into lines no wider than `width`; words longer than a line are split. */
export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const fits = (value: string) => font.widthOfTextAtSize(value, size) <= width;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ").filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    let rest = word;
    while (!fits(rest)) {
      let cut = rest.length - 1;
      while (cut > 1 && !fits(rest.slice(0, cut))) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

/** Cuts a line with "…" so it fits `width`. */
function ellipsize(text: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let cut = text.length;
  while (cut > 0 && font.widthOfTextAtSize(`${text.slice(0, cut).trimEnd()}…`, size) > width) cut--;
  return `${text.slice(0, cut).trimEnd()}…`;
}

export interface Fitted {
  lines: string[];
  size: number;
  lineHeight: number;
  /** True when text was cut off even at the smallest size. */
  truncated: boolean;
}

/**
 * Wraps paragraphs into a box, trying sizes from `max` down to `min`; at
 * `min` whatever doesn't fit is dropped and the last line ends with "…".
 */
export function fit(
  paragraphs: string[],
  font: PDFFont,
  { max, min, width, height, leading = 1.22 }: { max: number; min: number; width: number; height: number; leading?: number },
): Fitted {
  const wrapAll = (size: number) => paragraphs.flatMap((p) => (p ? wrap(p, font, size, width) : []));
  for (let size = max; size >= min; size -= 0.5) {
    const lines = wrapAll(size);
    const lineHeight = size * leading;
    if (lines.length * lineHeight <= height + 0.01) return { lines, size, lineHeight, truncated: false };
  }
  const lineHeight = min * leading;
  const all = wrapAll(min);
  const room = Math.max(1, Math.floor((height + 0.01) / lineHeight));
  if (all.length <= room) return { lines: all, size: min, lineHeight, truncated: false };
  const lines = all.slice(0, room);
  lines[room - 1] = ellipsize(`${lines[room - 1]}…`, font, min, width);
  return { lines, size: min, lineHeight, truncated: true };
}

class Canvas {
  readonly texts: DrawnText[] = [];

  constructor(
    private readonly page: PDFPage,
    readonly fonts: Fonts,
  ) {}

  font(bold: boolean) {
    return bold ? this.fonts.bold : this.fonts.regular;
  }

  /** Draws one line with its baseline at `y`. */
  text(
    text: string,
    x: number,
    y: number,
    { size, bold = false, grey = false, region }: { size: number; bold?: boolean; grey?: boolean; region: string },
  ) {
    if (!text) return;
    this.page.drawText(text, { x, y, size, font: this.font(bold), color: grey ? GREY : BLACK });
    this.texts.push({ text, x: round(x), y: round(y), size, bold, region });
  }

  /** Draws fitted lines from `top` down; returns the y below the last line. */
  lines(fitted: Fitted, x: number, top: number, options: { bold?: boolean; grey?: boolean; region: string }) {
    let y = top;
    for (const line of fitted.lines) {
      y -= fitted.lineHeight;
      this.text(line, x, y + (fitted.lineHeight - fitted.size) / 2, { ...options, size: fitted.size });
    }
    return y;
  }

  rect(x: number, y: number, width: number, height: number, { dashed = false, thickness = 0.8 } = {}) {
    this.page.drawRectangle({
      x,
      y,
      width,
      height,
      borderColor: BLACK,
      borderWidth: thickness,
      ...(dashed ? { borderDashArray: DASH } : {}),
    });
  }

  line(x1: number, y1: number, x2: number, y2: number, { dashed = false, thickness = 0.6, grey = false } = {}) {
    this.page.drawLine({
      start: { x: x1, y: y1 },
      end: { x: x2, y: y2 },
      thickness,
      color: grey ? GREY : BLACK,
      ...(dashed ? { dashArray: DASH } : {}),
    });
  }

  fill(x: number, y: number, width: number, height: number) {
    this.page.drawRectangle({ x, y, width, height, color: BLACK, borderWidth: 0 });
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Draws the QR code for `payload` as vector squares; returns its module count. */
function drawQr(canvas: Canvas, payload: string, x: number, y: number, size: number): number {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const count = qr.modules.size;
  const quiet = 4;
  const cell = size / (count + quiet * 2);
  for (let row = 0; row < count; row++) {
    let run = -1;
    for (let col = 0; col <= count; col++) {
      const dark = col < count && qr.modules.get(row, col);
      if (dark && run < 0) run = col;
      if (!dark && run >= 0) {
        canvas.fill(
          x + (quiet + run) * cell,
          y + size - (quiet + row + 1) * cell,
          (col - run) * cell,
          cell,
        );
        run = -1;
      }
    }
  }
  return count;
}

export async function renderPostageSlip(input: PostageSlipInput): Promise<PostageSlip> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(NOTO_SANS_REGULAR, { subset: true, customName: "ShopCareSans" });
  const bold = await doc.embedFont(NOTO_SANS_BOLD, { subset: true, customName: "ShopCareSans-Bold" });
  const boldSet = new Set(bold.getCharacterSet());
  const charset = new Set(regular.getCharacterSet().filter((cp) => boldSet.has(cp)));
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const canvas = new Canvas(page, { regular, bold, charset });
  const p = (value: string | null | undefined) => printable(value, charset);

  const ticket = `REPAIR #${p(String(input.ticketNumber))}`;
  const store = p(input.storeName) || "Our workshop";
  const date = slipDate(input.date);
  const contentWidth = PAGE_WIDTH - MARGIN * 2;

  // --- Page header
  let top = PAGE_HEIGHT - MARGIN;
  const headerSize = 11;
  canvas.text(ellipsize(store, bold, headerSize, contentWidth * 0.6), MARGIN, top - headerSize, {
    size: headerSize,
    bold: true,
    region: "page",
  });
  const headerRight = `Postage slip · ${ticket.replace("REPAIR", "Repair")}`;
  canvas.text(headerRight, PAGE_WIDTH - MARGIN - regular.widthOfTextAtSize(headerRight, 9), top - headerSize, {
    size: 9,
    grey: true,
    region: "page",
  });
  top -= headerSize + 10;
  canvas.line(MARGIN, top, PAGE_WIDTH - MARGIN, top, { grey: true, thickness: 0.4 });
  top -= 16;

  // --- (a) The address label: a dashed box to cut out
  const labelWidth = 336;
  const labelHeight = 252;
  const pad = 14;
  const inner = labelWidth - pad * 2;
  const labelBottom = top - labelHeight;
  canvas.rect(MARGIN, labelBottom, labelWidth, labelHeight, { dashed: true, thickness: 1 });

  let y = top - pad;
  canvas.text("TO:", MARGIN + pad, y - 8, { size: 8, bold: true, region: "label" });
  y -= 12;
  const workshop = fit(input.workshop.map(p), bold, { max: 19, min: 9, width: inner, height: 108, leading: 1.18 });
  canvas.lines(workshop, MARGIN + pad, y, { bold: true, region: "label" });
  y -= 108 + 8;
  canvas.line(MARGIN + pad, y, MARGIN + labelWidth - pad, y, { thickness: 0.5 });
  y -= 6;
  const ticketFit = fit([ticket], bold, { max: 26, min: 12, width: inner, height: 32, leading: 1.15 });
  y = canvas.lines(ticketFit, MARGIN + pad, y, { bold: true, region: "label" });
  y -= 6;
  canvas.line(MARGIN + pad, y, MARGIN + labelWidth - pad, y, { thickness: 0.5 });
  y -= 6;
  canvas.text("FROM:", MARGIN + pad, y - 7, { size: 7, bold: true, region: "label" });
  y -= 9;
  const from = [input.customer.name, ...input.customer.addressLines].map(p).filter(Boolean);
  const fromFit = fit(from.length ? from : ["(your name and address)"], regular, {
    max: 9,
    min: 6.5,
    width: inner,
    height: y - (labelBottom + pad) + 2,
    leading: 1.2,
  });
  canvas.lines(fromFit, MARGIN + pad, y, { region: "label" });
  canvas.text("Cut out this label and stick it on the outside of your parcel.", MARGIN, labelBottom - 12, {
    size: 7.5,
    grey: true,
    region: "label",
  });

  // --- (c) Posting instructions, beside the label
  const sideX = MARGIN + labelWidth + 18;
  const sideWidth = PAGE_WIDTH - MARGIN - sideX;
  canvas.text("How to send your item", sideX, top - 11, { size: 11, bold: true, region: "instructions" });
  const paragraphs = String(input.instructions ?? "")
    .split(/\n+/)
    .map(p)
    .filter(Boolean);
  const instructions = fit(paragraphs, regular, {
    max: 9.5,
    min: 6.5,
    width: sideWidth,
    height: labelHeight - 22,
    leading: 1.35,
  });
  canvas.lines(instructions, sideX, top - 20, { region: "instructions" });

  // --- Cut line between the label and the packing slip
  const cutY = labelBottom - 34;
  canvas.line(MARGIN - 12, cutY, PAGE_WIDTH - MARGIN + 12, cutY, { dashed: true, thickness: 0.6 });
  const cutText = "Cut here. The packing slip below goes inside the parcel.";
  canvas.text(cutText, (PAGE_WIDTH - regular.widthOfTextAtSize(cutText, 7.5)) / 2, cutY - 11, {
    size: 7.5,
    grey: true,
    region: "page",
  });

  // --- (b) The packing slip
  const slipTop = cutY - 30;
  const qrSize = 116;
  const qrX = PAGE_WIDTH - MARGIN - qrSize;
  const qrY = slipTop - qrSize;
  const modules = drawQr(canvas, input.qrUrl, qrX, qrY, qrSize);
  const qrCaption = fit(["Workshop: scan to open this repair in ShopCare"], regular, {
    max: 7,
    min: 6,
    width: qrSize - 12,
    height: 20,
  });
  canvas.lines(qrCaption, qrX + 6, qrY + 2, { grey: true, region: "slip" });

  const leftWidth = contentWidth - qrSize - 18;
  y = slipTop;
  canvas.text("PACKING SLIP", MARGIN, y - 9, { size: 9, bold: true, grey: true, region: "slip" });
  y -= 14;
  const storeFit = fit([store], bold, { max: 20, min: 11, width: leftWidth, height: 26 });
  y = canvas.lines(storeFit, MARGIN, y, { bold: true, region: "slip" });
  y -= 4;
  const slipTicket = fit([ticket], bold, { max: 28, min: 14, width: leftWidth, height: 34, leading: 1.15 });
  y = canvas.lines(slipTicket, MARGIN, y, { bold: true, region: "slip" });
  canvas.text(date, MARGIN, y - 14, { size: 10, region: "slip" });
  y -= 22;
  y = Math.min(y, qrY - 30);

  // Label / value rows.
  const labelCol = 96;
  const valueX = MARGIN + labelCol;
  const valueWidth = contentWidth - labelCol;
  const footerY = MARGIN;
  const row = (label: string, values: string[], { max = 10.5, maxHeight = 60 } = {}) => {
    const fitted = fit(values.map(p).filter(Boolean), regular, {
      max,
      min: 7,
      width: valueWidth,
      height: Math.max(12, Math.min(maxHeight, y - footerY - 24)),
      leading: 1.3,
    });
    if (!fitted.lines.length) return;
    y -= 6;
    canvas.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, { grey: true, thickness: 0.3 });
    y -= 4;
    canvas.text(label, MARGIN, y - fitted.lineHeight + (fitted.lineHeight - 8.5) / 2, {
      size: 8.5,
      bold: true,
      region: "slip",
    });
    y = canvas.lines(fitted, valueX, y, { region: "slip" });
  };
  row("Customer", [input.customer.name]);
  row("Email", [input.customer.email]);
  row("Return address", [input.customer.addressLines.map(p).filter(Boolean).join(", ")], { maxHeight: 40 });
  row("Item", [[input.product, input.variant].map(p).filter(Boolean).join(" · ")]);
  row(p(input.repair.heading) || "Repair", input.repair.lines.length ? input.repair.lines : ["—"], {
    maxHeight: 400,
  });

  canvas.text(`${store} · ${ticket.replace("REPAIR", "Repair")} · ${date}`, MARGIN, footerY - 4, {
    size: 7,
    grey: true,
    region: "page",
  });

  doc.setTitle(`${ticket.replace("REPAIR", "Repair")} postage slip`);
  doc.setSubject(`Postage slip for ${ticket.replace("REPAIR", "repair")}`);
  doc.setAuthor(store);
  doc.setCreator("ShopCare");
  doc.setProducer("ShopCare");
  doc.setCreationDate(input.date);
  doc.setModificationDate(input.date);

  const pdf = await doc.save({ useObjectStreams: false });
  return {
    pdf,
    texts: canvas.texts,
    qr: { payload: input.qrUrl, x: round(qrX), y: round(qrY), size: qrSize, modules },
  };
}
