/**
 * A customer registering a product bought outside Shopify (in a shop, from a
 * stockist, as a gift). Accepted straight away so the customer gets cover, but
 * flagged `unverified` until staff check the proof of purchase. Port of
 * Registration (`has_one_attached :proof` → proof* columns + file storage).
 */
import type { Prisma, Registration } from "@prisma/client";
import prisma from "../db.server";
import { type Db, inTransaction } from "../lib/db-lock.server";
import { presence } from "../lib/inflections";
import { cancelCover } from "./cover.server";
import { assertValid, Errors, validateInclusion, validateMaxLength } from "./validation.server";

export const REGISTRATION_STATUSES = ["unverified", "verified", "rejected"] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];
export const PROOF_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];
export const PROOF_MAX_BYTES = 10 * 1024 * 1024;

type Validatable = Pick<
  Prisma.RegistrationUncheckedCreateInput,
  "status" | "retailer" | "proofKey" | "proofContentType" | "proofByteSize"
>;

export function validateRegistration(r: Validatable): Errors {
  const errors = new Errors();
  validateInclusion(errors, "status", r.status ?? "unverified", REGISTRATION_STATUSES);
  validateMaxLength(errors, "retailer", r.retailer, 200);
  if (r.proofKey) {
    if (!PROOF_TYPES.includes(r.proofContentType ?? "")) errors.add("proof", "must be a photo or PDF");
    if ((r.proofByteSize ?? 0) > PROOF_MAX_BYTES) errors.add("proof", "must be smaller than 10 MB");
  }
  return errors;
}

export async function createRegistration(
  data: Prisma.RegistrationUncheckedCreateInput,
  db: Db = prisma,
): Promise<Registration> {
  assertValid("Registration", validateRegistration(data));
  return db.registration.create({ data });
}

/** Staff checked the proof: the registration is verified and the item active. */
export function verifyRegistration(
  id: number,
  { note = null }: { note?: string | null } = {},
  db: Db = prisma,
): Promise<Registration> {
  return inTransaction(db, async (tx) => {
    const registration = await tx.registration.update({
      where: { id },
      data: { status: "verified", reviewedAt: new Date(), reviewNote: presence(note) },
    });
    await tx.item.update({ where: { id: registration.itemId }, data: { status: "active" } });
    return registration;
  });
}

/** A rejected registration voids the item and cancels its cover. */
export function rejectRegistration(
  id: number,
  { note = null }: { note?: string | null } = {},
  db: Db = prisma,
): Promise<Registration> {
  return inTransaction(db, async (tx) => {
    const registration = await tx.registration.update({
      where: { id },
      data: { status: "rejected", reviewedAt: new Date(), reviewNote: presence(note) },
    });
    await tx.item.update({ where: { id: registration.itemId }, data: { status: "void" } });
    const covers = await tx.cover.findMany({
      where: { itemId: registration.itemId, status: "active" },
      select: { id: true },
    });
    for (const cover of covers) await cancelCover(cover.id, tx);
    return registration;
  });
}
