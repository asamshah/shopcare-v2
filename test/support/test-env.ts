/**
 * Environment for every test run, so tests never depend on a developer's
 * .env. Used by vitest.config.ts and by the global setup, which runs in the
 * main process before project env vars are applied.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://shopcare:shopcare@localhost:55433/shopcare_test";

// Fixed, obviously fake secrets.
export const testEnv = {
  NODE_ENV: "test",
  DATABASE_URL: TEST_DATABASE_URL,
  DIRECT_URL: TEST_DATABASE_URL,
  SHOPIFY_API_KEY: "test_api_key",
  SHOPIFY_API_SECRET: "shpss_test_secret",
  SHOPIFY_APP_URL: "https://shopcare.test",
  SCOPES: "read_products",
  // 32 zero bytes, base64. Test only.
  APP_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  APP_ENCRYPTION_PREVIOUS_KEYS: "",
  STORAGE_DRIVER: "memory",
  BACKGROUND_DISPATCH: "sync",
};
