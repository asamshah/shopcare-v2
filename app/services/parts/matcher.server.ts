/**
 * Picks the part variant a recipe line needs for a particular item, using the
 * component's rules (see app/models/service-component.server.ts). Returns the
 * variant when exactly one fits, plus the candidates so staff can choose when
 * it's ambiguous. Port of Parts::Matcher.
 */
import type { Part, PartVariant, ServiceComponent } from "@prisma/client";
import { partOptionNames } from "../../models/part.server";
import { variantMatches } from "../../models/part-variant.server";
import { ruleFor } from "../../models/service-component.server";

/** Item property each part option is matched against. */
export const ITEM_KEYS: Record<string, string> = { size: "size", colour: "colour", model: "sole_model" };

export interface MatchResult {
  variant: PartVariant | null;
  candidates: PartVariant[];
}

export type MatchableComponent = Pick<ServiceComponent, "match"> & {
  part: Pick<Part, "optionNames"> & { variants: PartVariant[] };
};

function present(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.trim() === "" ? null : text;
}

/** null means "don't filter on this option". */
function wantedValue(
  component: Pick<ServiceComponent, "match">,
  option: string,
  properties: Record<string, unknown>,
): string | null {
  const [kind, fixed] = ruleFor(component, option);
  if (kind === "fixed") return fixed;
  if (kind === "item") return present(properties[ITEM_KEYS[option] ?? option]);
  return null;
}

export function matchComponent(
  component: MatchableComponent,
  properties: Record<string, unknown> | null | undefined,
): MatchResult {
  let candidates = [...component.part.variants].sort((a, b) => a.id - b.id);
  for (const option of partOptionNames(component.part)) {
    const value = wantedValue(component, option, properties ?? {});
    if (value !== null) candidates = candidates.filter((v) => variantMatches(v, option, value));
  }
  return { variant: candidates.length === 1 ? candidates[0] : null, candidates };
}
