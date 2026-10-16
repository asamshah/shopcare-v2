// STUB(w2-admin): the contract's Result type; w2-backend owns app/services/quotes/*.
export type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

export type Actor = "staff" | "system" | "customer";

export const NOT_PORTED = "This action isn't available yet.";
