/**
 * Runs Admin GraphQL operations for every module in app/shopify/.
 *
 * The client is anything with the template's `admin.graphql(query, { variables })`
 * shape: the `admin` from `authenticate.admin(request)` (a merchant request),
 * from `adminClientForShop(shop)` (jobs, webhooks, the App Proxy), or the
 * test fake (test/support/fake-graphql.ts).
 *
 * `adminGraphql()` returns the typed `data`, retries when Shopify throttles
 * (GraphQL `THROTTLED` or HTTP 429) with backoff, and throws
 * `ShopifyGraphqlError` for any other GraphQL error. Mutations check their
 * `userErrors` with `assertNoUserErrors()`, which throws `ShopifyUserError`.
 * Ported from Rails `Shopify::AdminApi#graphql`.
 */

export type GraphqlVariables = Record<string, unknown>;

/** The subset of the template's AdminApiContext that ShopCare uses. */
export interface AdminGraphqlClient {
  graphql(
    query: string,
    options?: { variables?: GraphqlVariables },
  ): Promise<Response>;
  /** Default retry policy for every call through this client (see withRetry). */
  retry?: RetryOptions;
}

export interface GraphqlErrorDetail {
  message: string;
  path?: (string | number)[];
  extensions?: { code?: string; [key: string]: unknown };
}

export interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

/** A GraphQL-level failure (bad query, access denied, still throttled, …). */
export class ShopifyGraphqlError extends Error {
  constructor(
    message: string,
    readonly errors: GraphqlErrorDetail[] = [],
  ) {
    super(message);
    this.name = "ShopifyGraphqlError";
  }

  get throttled(): boolean {
    return this.errors.some((e) => e.extensions?.code === "THROTTLED");
  }
}

/** A mutation's `userErrors` (invalid input, not allowed, …). */
export class ShopifyUserError extends Error {
  constructor(
    readonly operation: string,
    readonly userErrors: UserError[],
  ) {
    super(userErrors.map((e) => e.message).join(", "));
    this.name = "ShopifyUserError";
  }
}

export interface RetryOptions {
  /** Total attempts, including the first. Default 5. */
  maxAttempts?: number;
  /** First backoff when Shopify gives no hint. Doubles each retry. Default 1000. */
  baseDelayMs?: number;
  /** Upper bound for any single wait. Default 10000. */
  maxDelayMs?: number;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Storefront requests wait on Shopify while a customer watches a spinner, so
 * when Shopify throttles they retry once, briefly, and then fail (the block
 * shows its "try again" state). Jobs keep the default: 5 attempts, up to 10 s
 * apart.
 */
export const STOREFRONT_RETRY: RetryOptions = { maxAttempts: 2, maxDelayMs: 2000 };

/** The same client with a different default retry policy. */
export function withRetry(client: AdminGraphqlClient, retry: RetryOptions): AdminGraphqlClient {
  return { graphql: (query, options) => client.graphql(query, options), retry: { ...client.retry, ...retry } };
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ThrottleStatus {
  maximumAvailable?: number;
  currentlyAvailable?: number;
  restoreRate?: number;
}

interface CostExtension {
  requestedQueryCost?: number;
  throttleStatus?: ThrottleStatus;
}

interface ResponseBody<T> {
  data?: T | null;
  errors?: GraphqlErrorDetail[] | { message?: string };
  extensions?: { cost?: CostExtension };
}

/** A failure we may retry after a pause, with Shopify's hint when it gave one. */
class Throttled extends Error {
  constructor(
    readonly waitMs: number | null,
    readonly cause: unknown,
  ) {
    super("Throttled");
  }
}

/**
 * Runs a query or mutation and returns its `data`. Throws ShopifyGraphqlError
 * on GraphQL errors (after retrying throttling) and passes network errors on.
 */
export async function adminGraphql<T>(
  client: AdminGraphqlClient,
  query: string,
  variables: GraphqlVariables = {},
  callRetry: RetryOptions = {},
): Promise<T> {
  const retry = { ...client.retry, ...callRetry };
  const maxAttempts = retry.maxAttempts ?? 5;
  const baseDelay = retry.baseDelayMs ?? 1000;
  const maxDelay = retry.maxDelayMs ?? 10_000;
  const sleep = retry.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptOnce<T>(client, query, variables);
    } catch (error) {
      if (!(error instanceof Throttled)) throw error;
      if (attempt >= maxAttempts) {
        if (error.cause instanceof ShopifyGraphqlError) throw error.cause;
        throw new ShopifyGraphqlError(
          `Shopify is still throttling after ${attempt} attempts`,
          [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        );
      }
      const backoff = baseDelay * 2 ** (attempt - 1);
      await sleep(Math.min(maxDelay, Math.max(error.waitMs ?? 0, backoff)));
    }
  }
}

async function attemptOnce<T>(
  client: AdminGraphqlClient,
  query: string,
  variables: GraphqlVariables,
): Promise<T> {
  let response: Response;
  try {
    response = await client.graphql(query, { variables });
  } catch (error) {
    throw fromClientError(error);
  }

  if (response.status === 429) {
    throw new Throttled(
      retryAfterMs(response.headers.get("Retry-After")),
      null,
    );
  }
  const body = (await response.json()) as ResponseBody<T>;
  const errors = normaliseErrors(body.errors);
  if (errors.length > 0) {
    const error = new ShopifyGraphqlError(
      errors.map((e) => e.message).join("; "),
      errors,
    );
    if (error.throttled)
      throw new Throttled(waitFromCost(body.extensions?.cost), error);
    throw error;
  }
  if (body.data === undefined || body.data === null) {
    throw new ShopifyGraphqlError("Shopify returned no data");
  }
  return body.data;
}

/**
 * The library client throws instead of returning errors: GraphqlQueryError
 * (`body.errors.graphQLErrors`, HTTP 200) and HttpThrottlingError (429,
 * `retryAfter` in seconds). Anything else (network, 5xx) is passed on.
 */
function fromClientError(error: unknown): unknown {
  if (!error || typeof error !== "object") return error;
  const e = error as {
    name?: string;
    message?: string;
    retryAfter?: number;
    body?: {
      errors?: { graphQLErrors?: GraphqlErrorDetail[] };
      extensions?: { cost?: CostExtension };
    };
  };
  if (
    e.name === "HttpThrottlingError" ||
    e.constructor?.name === "HttpThrottlingError"
  ) {
    return new Throttled(
      typeof e.retryAfter === "number" ? e.retryAfter * 1000 : null,
      error,
    );
  }
  const graphQLErrors = e.body?.errors?.graphQLErrors;
  if (Array.isArray(graphQLErrors) && graphQLErrors.length > 0) {
    const gqlError = new ShopifyGraphqlError(
      graphQLErrors.map((g) => g.message).join("; "),
      graphQLErrors,
    );
    if (gqlError.throttled)
      return new Throttled(waitFromCost(e.body?.extensions?.cost), gqlError);
    return gqlError;
  }
  return error;
}

function normaliseErrors(
  errors: ResponseBody<unknown>["errors"],
): GraphqlErrorDetail[] {
  if (!errors) return [];
  if (Array.isArray(errors)) return errors;
  return errors.message ? [{ message: errors.message }] : [];
}

/** Time until the bucket holds the requested cost again. */
function waitFromCost(cost: CostExtension | undefined): number | null {
  const status = cost?.throttleStatus;
  if (!cost?.requestedQueryCost || !status?.restoreRate) return null;
  const missing = cost.requestedQueryCost - (status.currentlyAvailable ?? 0);
  return missing > 0 ? Math.ceil((missing / status.restoreRate) * 1000) : null;
}

function retryAfterMs(header: string | null): number | null {
  const seconds = header ? Number.parseFloat(header) : NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** Throws ShopifyUserError when a mutation payload reports userErrors. */
export function assertNoUserErrors(
  operation: string,
  payload: { userErrors?: UserError[] | null } | null | undefined,
): void {
  if (!payload) {
    throw new ShopifyGraphqlError(`${operation} returned no payload`);
  }
  const userErrors = payload.userErrors ?? [];
  if (userErrors.length > 0) throw new ShopifyUserError(operation, userErrors);
}

/** Money as Shopify's Decimal string: 12.5 → "12.50". */
export function moneyString(amount: number | string): string {
  const value = typeof amount === "number" ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(value)) throw new Error(`Not an amount: ${amount}`);
  return value.toFixed(2);
}

/** "ShopifyGraphqlError: Access denied", for log lines. */
export function errorSummary(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
