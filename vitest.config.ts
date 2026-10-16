/**
 * Vitest: three projects.
 *   unit         pure functions; no database or network; runs in parallel
 *   integration  real Postgres (TEST_DATABASE_URL), migrated once per run,
 *                truncated before every test, files run one at a time
 *   storefront   the theme extension's Liquid + JS in jsdom (no database)
 *
 * Locally, Postgres is the `shopcare-v2-pg` Docker container (see README).
 * In CI it's a service container.
 */
import { defineConfig } from "vitest/config";
import { testEnv as env } from "./test/support/test-env";

export default defineConfig({
  test: {
    env,
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          env,
        },
      },
      {
        test: {
          name: "storefront",
          include: ["test/storefront/**/*.test.js"],
          env,
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          env,
          globalSetup: ["test/support/global-setup.ts"],
          setupFiles: ["test/support/integration-setup.ts"],
          // One shared database, so test files mustn't run concurrently.
          fileParallelism: false,
        },
      },
    ],
  },
});
