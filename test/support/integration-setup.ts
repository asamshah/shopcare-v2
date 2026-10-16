/**
 * Per-file setup for integration tests: a clean database before every test,
 * like Rails' transactional tests, and a disconnect at the end.
 */
import { afterAll, beforeEach } from "vitest";
import prisma from "../../app/db.server";
import { resetDatabase } from "./db";

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});
