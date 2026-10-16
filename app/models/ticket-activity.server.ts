/** The ticket's running log (replaces Odoo chatter). Port of TicketActivity. */
import type { Prisma, TicketActivity } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { assertValid, Errors, validateInclusion } from "./validation.server";

export const ACTIVITY_TYPES = [
  "note",
  "status_change",
  "quote_sent",
  "quote_decision",
  "payment",
  "system",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export const ACTIVITY_AUTHORS = ["staff", "system", "customer"] as const;
export type ActivityAuthor = (typeof ACTIVITY_AUTHORS)[number];

export function validateTicketActivity(
  activity: Pick<Prisma.TicketActivityUncheckedCreateInput, "activityType" | "author">,
): Errors {
  const errors = new Errors();
  if (!activity.activityType) errors.add("activityType", "can't be blank");
  validateInclusion(errors, "activityType", activity.activityType, ACTIVITY_TYPES);
  validateInclusion(errors, "author", activity.author ?? "staff", ACTIVITY_AUTHORS);
  return errors;
}

export async function createTicketActivity(
  data: Prisma.TicketActivityUncheckedCreateInput,
  db: Db = prisma,
): Promise<TicketActivity> {
  assertValid("TicketActivity", validateTicketActivity(data));
  return db.ticketActivity.create({ data });
}
