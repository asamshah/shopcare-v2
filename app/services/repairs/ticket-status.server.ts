// STUB(w2-admin): owned by w2-backend. Integration replaces this file.
/* eslint-disable @typescript-eslint/no-unused-vars -- stub signatures */
// Rails TicketsController#update_status: validates the transition, logs a status_change activity,
// dispatches repairStatusChangedEvent, consumes parts on completion (parts_enabled), cancels open
// quotes on cancel. `message`, when given, is the full flash notice (e.g. with the parts used).
import type { Actor, Result } from "../quotes/result.server";
import { NOT_PORTED } from "../quotes/result.server";

export async function changeTicketStatus(_args: {
  shopId: number;
  ticketId: number;
  to: string;
  actor: Actor;
  note?: string;
}): Promise<Result<{ message?: string }>> {
  return { ok: false, error: NOT_PORTED };
}
