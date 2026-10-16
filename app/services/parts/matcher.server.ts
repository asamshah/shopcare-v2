/**
 * Picks the part variant a recipe line needs for a particular item, using the
 * component's rules (ServiceComponent `match`). Returns the variant when
 * exactly one fits, plus the candidates so staff can choose when it's
 * ambiguous. Port of Parts::Matcher.
 */
import type { Part, PartVariant, ServiceComponent } from "@prisma/client";
import { variantMatches } from "../../models/part-variant.server";
import { ruleFor } from "../../models/service-component.server";
import { jsonArray } from "../../models/validation.server";

/** Item property each part option is matched against. */
export const ITEM_KEYS: Record<string, string> = {
  size: "size",
  colour: "colour",
  model: "sole_model",
};

export interface Match {
  variant: PartVariant | null;
  candidates: PartVariant[];
}

export type MatchableComponent = Pick<ServiceComponent, "match"> & {
  part: Pick<Part, "optionNames"> & { variants: PartVariant[] };
};

export function matchComponent(
  component: MatchableComponent,
  properties: Record<string, unknown> = {},
): Match {
  let candidates = [...component.part.variants];
  for (const option of jsonArray(component.part.optionNames).map(String)) {
    const [kind, fixed] = ruleFor(component, option);
    let value: unknown = null;
    if (kind === "fixed") value = fixed;
    else if (kind === "item") {
      const raw = properties[ITEM_KEYS[option] ?? option];
      value = raw === undefined || raw === null || String(raw).trim() === "" ? null : raw;
    }
    if (value !== null) {
      candidates = candidates.filter((variant) => variantMatches(variant, option, value));
    }
  }
  return { variant: candidates.length === 1 ? candidates[0] : null, candidates };
}
