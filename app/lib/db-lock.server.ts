/**
 * Row locking and transactions for the model layer: the counterpart of Rails'
 * `with_lock` and `transaction`.
 *
 * `withRowLock(tx, table, id)` runs `SELECT … FOR UPDATE` on one row inside an
 * interactive transaction, so concurrent updates to that row wait their turn
 * (a cover's claim count, a part variant's stock). Read the row again *after*
 * taking the lock: anything read before it may be stale.
 *
 *   await inTransaction(db, async (tx) => {
 *     await withRowLock(tx, "covers", coverId);
 *     const cover = await tx.cover.findUniqueOrThrow({ where: { id: coverId } });
 *     …
 *   });
 */
import { Prisma, type PrismaClient } from "@prisma/client";

/** The Prisma client, or the client inside an interactive transaction. */
export type Db = PrismaClient | Prisma.TransactionClient;

export class RecordNotFoundError extends Error {
  constructor(table: string, id: number) {
    super(`No ${table} row with id ${id}.`);
    this.name = "RecordNotFoundError";
  }
}

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Locks one row until the surrounding transaction ends. `table` is the SQL
 * table name (e.g. "covers"); it's checked against a strict pattern because it
 * can't be a bind parameter. Throws RecordNotFoundError if the row is gone.
 */
export async function withRowLock(
  tx: Prisma.TransactionClient,
  table: string,
  id: number,
): Promise<void> {
  if (!TABLE_NAME.test(table)) {
    throw new Error(`Not a table name: ${JSON.stringify(table)}`);
  }
  const rows = await tx.$queryRaw<{ id: number }[]>(
    Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id} FOR UPDATE`,
  );
  if (rows.length === 0) throw new RecordNotFoundError(table, id);
}

function isTransactionClient(db: Db): db is Prisma.TransactionClient {
  return !("$transaction" in db);
}

/**
 * Runs `fn` in an interactive transaction, or directly when `db` is already a
 * transaction client (so model functions compose inside a caller's
 * transaction, like nested Rails `transaction` blocks).
 */
export function inTransaction<T>(
  db: Db,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (isTransactionClient(db)) return fn(db);
  return (db as PrismaClient).$transaction(fn);
}

/** True for a unique-constraint violation (Rails ActiveRecord::RecordNotUnique). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
