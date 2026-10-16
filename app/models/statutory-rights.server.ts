/**
 * The sentence every customer-facing cover summary ends with: warranty and Care
 * add to the customer's legal rights, never replace them. Fixed text, not a
 * setting. Port of StatutoryRights.
 */
export function statutoryRightsNotice(what = "cover"): string {
  return `This ${what} is in addition to, and does not affect, your statutory rights.`;
}
