/**
 * Database helpers for integration tests.
 *
 * `resetDatabase()` truncates every application table (not Prisma's migration
 * history) in one statement, so each test starts empty. It's faster than
 * re-migrating and needs no list of tables to maintain as models are ported.
 */
import prisma from "../../app/db.server";

let tables: string[] | undefined;

async function applicationTables(): Promise<string[]> {
  if (!tables) {
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
    tables = rows.map((r) => `"${r.tablename.replace(/"/g, '""')}"`);
  }
  return tables;
}

export async function resetDatabase(): Promise<void> {
  const names = await applicationTables();
  if (names.length === 0) return;
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${names.join(", ")} RESTART IDENTITY CASCADE`,
  );
}
