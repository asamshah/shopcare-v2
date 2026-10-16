/**
 * Boolean attributes for Polaris web components under React 18: React writes
 * custom-element props as attributes, so `checked={false}` would still be a
 * present attribute. Spread these instead: `<s-checkbox {...checkedIf(on)}>`.
 */
export const checkedIf = (on: boolean) => (on ? { checked: true as const } : {});
export const selectedIf = (on: boolean) => (on ? { selected: true as const } : {});
export const disabledIf = (on: boolean) => (on ? { disabled: true as const } : {});
