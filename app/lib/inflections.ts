/**
 * The few ActiveSupport string helpers the ported models rely on, with the
 * same output for the inputs ShopCare uses.
 */

/** "status_change" → "Status change" (ActiveSupport `humanize`). */
export function humanize(value: string): string {
  const text = value.replace(/_id$/, "").replace(/_/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "acme boots" → "Acme Boots" (ActiveSupport `titleize`, for plain words). */
export function titleize(value: string): string {
  return humanize(value.replace(/-/g, " ")).replace(/\b([a-z])/g, (c) =>
    c.toUpperCase(),
  );
}

/** "Like new!" → "like_new" (ActiveSupport `parameterize(separator: "_")`). */
export function parameterize(value: string, separator = "-"): string {
  const escaped = separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, separator)
    .replace(new RegExp(`${escaped}{2,}`, "g"), separator)
    .replace(new RegExp(`^${escaped}|${escaped}$`, "g"), "");
}

/** ["a", "b", "c"] → "a, b or c" (`to_sentence` with "or" connectors). */
export function toSentence(words: string[], connector = "and"): string {
  if (words.length <= 1) return words.join("");
  if (words.length === 2) return `${words[0]} ${connector} ${words[1]}`;
  return `${words.slice(0, -1).join(", ")} ${connector} ${words[words.length - 1]}`;
}

/** Ruby `blank?`: null, undefined, false, whitespace-only strings, empty arrays and objects. */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

export const isPresent = (value: unknown) => !isBlank(value);

/** Ruby `presence` for strings: the string, or null when blank. */
export function presence(value: string | null | undefined): string | null {
  return value === null || value === undefined || isBlank(value) ? null : value;
}

/** Ruby `Hash#compact_blank`: drops blank values. */
export function compactBlank<T extends Record<string, unknown>>(hash: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(hash).filter(([, v]) => isPresent(v)),
  ) as Partial<T>;
}

/** The lines of a text field, stripped, blank lines dropped. */
export function nonBlankLines(text: string | null | undefined): string[] {
  return (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** ActiveModel::Type::Boolean cast: "1", "true", "on", true → true; "0", "false", "off", "" → false. */
export function castBoolean(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "string") {
    return !["0", "f", "false", "off", "F", "FALSE", "OFF"].includes(value);
  }
  return Boolean(value);
}
