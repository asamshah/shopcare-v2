/**
 * Runs once before the integration project: brings the test database up to
 * date with `prisma migrate deploy`, which also creates the database if it is
 * missing. Fails fast with a hint if Postgres isn't reachable.
 */
import { execSync } from "node:child_process";
import { TEST_DATABASE_URL } from "./test-env";

export default function setup() {
  const url = TEST_DATABASE_URL;
  try {
    execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      stdio: "pipe",
    });
  } catch (error) {
    const output = String((error as { stderr?: Buffer }).stderr ?? error);
    throw new Error(
      `Could not migrate the test database at ${url}.\n` +
        "Start Postgres with the command in README > Local Postgres, or set TEST_DATABASE_URL.\n" +
        output,
    );
  }
}
