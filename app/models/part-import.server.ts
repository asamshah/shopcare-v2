/**
 * A parts CSV the merchant uploaded. Nothing is written to parts or stock until
 * it's applied; the file stays as a record of the import. Port of PartImport
 * (the importer itself is app/services/parts/csv-import).
 */
import type { PartImport, Prisma } from "@prisma/client";
import prisma from "../db.server";
import type { Db } from "../lib/db-lock.server";
import { assertValid, Errors, validateInclusion, validatePresence } from "./validation.server";

export const PART_IMPORT_MODES = ["parts", "stock"] as const;
export type PartImportMode = (typeof PART_IMPORT_MODES)[number];

export function validatePartImport(
  data: Pick<Prisma.PartImportUncheckedCreateInput, "filename" | "csvData" | "mode">,
): Errors {
  const errors = new Errors();
  validatePresence(errors, "filename", data.filename);
  validatePresence(errors, "csvData", data.csvData);
  validateInclusion(errors, "mode", data.mode, PART_IMPORT_MODES);
  return errors;
}

export async function createPartImport(
  data: Prisma.PartImportUncheckedCreateInput,
  db: Db = prisma,
): Promise<PartImport> {
  assertValid("PartImport", validatePartImport(data));
  return db.partImport.create({ data });
}

export const isStockImport = (i: Pick<PartImport, "mode">) => i.mode === "stock";
export const isApplied = (i: Pick<PartImport, "appliedAt">) => i.appliedAt !== null;
