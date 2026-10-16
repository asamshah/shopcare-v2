/**
 * A photo on a repair ticket. Uploads live in file storage
 * (app/lib/storage.server.ts) under `storageKey`, never base64 in the
 * database; `url` is only for optionally referenced external images. Port of
 * TicketImage (`has_one_attached :file` → storage key + metadata columns).
 */
import type { Prisma, TicketImage } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { assertValid, Errors } from "./validation.server";

export const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/gif"];
export const MAX_BYTES = 10 * 1024 * 1024;

type Validatable = Pick<
  Prisma.TicketImageUncheckedCreateInput,
  "storageKey" | "url" | "contentType" | "byteSize"
>;

export function validateTicketImage(image: Validatable): Errors {
  const errors = new Errors();
  const attached = Boolean(image.storageKey);
  if (!attached && !image.url?.trim()) {
    errors.add("base", "must have an uploaded file or a url");
  }
  if (attached && !ALLOWED_TYPES.includes(image.contentType ?? "")) {
    errors.add("file", "must be a JPEG, PNG, WEBP, HEIC or GIF image");
  }
  if (attached && (image.byteSize ?? 0) > MAX_BYTES) {
    errors.add("file", `must be smaller than ${MAX_BYTES / 1024 / 1024} MB`);
  }
  return errors;
}

export async function createTicketImage(
  data: Prisma.TicketImageUncheckedCreateInput,
  db: Db = prisma,
): Promise<TicketImage> {
  assertValid("TicketImage", validateTicketImage(data));
  return db.ticketImage.create({ data });
}
