/**
 * Minimal RFC 4180 CSV reading and writing (Ruby's `CSV.parse` /
 * `CSV.generate` for the workshop-inventory spreadsheets). No dependency:
 * quoted fields, doubled quotes, CRLF/LF line endings and a chosen separator.
 */

export class MalformedCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedCsvError";
  }
}

/** Rows of fields. Throws MalformedCsvError on an unclosed or stray quote. */
export function parseCsv(text: string, separator = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  let line = 1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          const next = text[i + 1];
          if (next !== undefined && next !== separator && next !== "\n" && next !== "\r") {
            throw new MalformedCsvError(`Any value after quoted field isn't allowed in line ${line}.`);
          }
        }
      } else {
        if (char === "\n") line++;
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (!fieldStart) throw new MalformedCsvError(`Illegal quoting in line ${line}.`);
      quoted = true;
      fieldStart = false;
    } else if (char === separator) {
      row.push(field);
      field = "";
      fieldStart = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStart = true;
      line++;
    } else {
      field += char;
      fieldStart = false;
    }
  }
  if (quoted) throw new MalformedCsvError(`Unclosed quoted field in line ${line}.`);
  if (!fieldStart || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text)
    ?`"${text.replace(/"/g, '""')}"`
    : text;
}

/** CSV text, one line per row, ending in a newline (like CSV.generate). */
export function generateCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvField).join(",")).join("\n") + "\n";
}
