/**
 * Shared plumbing for the storefront App Proxy endpoints (/apps/repairs/… on
 * the shop → /proxy/… here). Port of Rails `Proxy::BaseController` and
 * `ProxyThrottling`.
 *
 * Signature check: the template's `authenticate.public.appProxy`. It does
 * what ShopifyApp::AppProxyVerification did (sorted "k=v" pairs, repeated
 * keys joined with ",", hex HMAC-SHA256 under the API secret, constant-time
 * compare) and more: it rejects a `timestamp` more than 90 s off and repeated
 * `shop`/`signature`/`timestamp` params, and returns the shop's offline
 * session plus Admin/Storefront clients. A bad signature is thrown as a 400
 * (Rails answered 403).
 *
 * Writing a route: see `proxyRoute` below and app/routes/proxy.ping.tsx.
 */
import { authenticate } from "../shopify.server";
import { verifiedCustomerId } from "./customer-token.server";
import { jsonResponse, liquidResponse, type CachePolicy } from "./http.server";
import {
  memoryThrottleStore,
  throttle,
  type ThrottleLimits,
  type ThrottleStore,
} from "./proxy-throttling.server";

type AppProxyAuth = Awaited<ReturnType<typeof authenticate.public.appProxy>>;

export const DEFAULT_PATH_PREFIX = "/apps/repairs";
const PATH_PREFIX = /^\/[a-z]+\/[\w-]+$/;

export interface AppProxyDeps {
  /** Checks Shopify's signature; throws a Response when it's invalid. */
  authenticate: (request: Request) => Promise<AppProxyAuth>;
  /**
   * The shop's customer signing key (Rails `Shop#customer_signing_key`), or
   * null. Only called when a request has no logged_in_customer_id.
   */
  customerSigningKey: (shop: string) => Promise<string | null | undefined>;
  /**
   * Called with a well-formed `path_prefix` so the shop can remember a
   * merchant-customised proxy path (Rails `remember_path_prefix`). It should
   * only write when the value changed.
   */
  rememberPathPrefix?: (shop: string, prefix: string) => Promise<void>;
  throttleStore: ThrottleStore;
  now: () => Date;
}

/**
 * Defaults until the Shop model lands. TODO(integration):
 *   customerSigningKey → the decrypted `Shop.customerSigningKey`
 *   rememberPathPrefix → update `Shop.settings.proxy_path_prefix`
 *   throttleStore      → postgresThrottleStore(prisma), once proxy_throttles exists
 * Until then no signed customer token verifies (fail closed:
 * logged_in_customer_id still works) and throttle counts are per instance.
 */
const defaults: AppProxyDeps = {
  authenticate: (request) => authenticate.public.appProxy(request),
  customerSigningKey: async () => null,
  throttleStore: memoryThrottleStore(),
  now: () => new Date(),
};

let current: AppProxyDeps = { ...defaults };

/** Swap dependencies (integration wiring, tests). Returns a restore function. */
export function configureAppProxy(
  overrides: Partial<AppProxyDeps>,
): () => void {
  const previous = current;
  current = { ...current, ...overrides };
  return () => {
    current = previous;
  };
}

export function appProxyDeps(): AppProxyDeps {
  return current;
}

export interface AppProxyContext {
  request: Request;
  params: URLSearchParams;
  /** The shop's myshopify domain (signed). */
  shop: string;
  session: AppProxyAuth["session"];
  admin: AppProxyAuth["admin"];
  storefront: AppProxyAuth["storefront"];
  /** The proxy path the storefront used, for links (`/apps/repairs` by default). */
  pathPrefix: string;
  /**
   * The logged-in customer's id, or null for a guest. Shopify's signed
   * logged_in_customer_id comes first; on new customer accounts it has been
   * reported blank (or stale) on some requests, so the blocks also send a
   * token Liquid signs (customer-token.server.ts). Never a bare id from the
   * browser: Shopify signs whatever query the visitor sends.
   */
  currentCustomerId(): Promise<string | null>;
  /** True once currentCustomerId() was called: the response is per customer. */
  readonly readsCustomer: boolean;
}

/**
 * Verifies the request and resolves the shop and customer. Throws 400 for a
 * bad signature. `session` is undefined when the shop hasn't installed the
 * app; `proxyRoute` turns that into a 404 like Rails.
 */
export async function authenticateProxy(
  request: Request,
  deps: AppProxyDeps = current,
): Promise<AppProxyContext> {
  const { session, admin, storefront } = await deps.authenticate(request);
  const params = new URL(request.url).searchParams;
  const shop = params.get("shop") ?? "";

  const prefix = params.get("path_prefix") ?? "";
  const pathPrefix = PATH_PREFIX.test(prefix) ? prefix : DEFAULT_PATH_PREFIX;
  if (session && pathPrefix === prefix && deps.rememberPathPrefix) {
    await deps.rememberPathPrefix(shop, prefix);
  }

  let customer: Promise<string | null> | undefined;
  let readsCustomer = false;
  return {
    request,
    params,
    shop,
    session,
    admin,
    storefront,
    pathPrefix,
    get readsCustomer() {
      return readsCustomer;
    },
    currentCustomerId() {
      readsCustomer = true;
      customer ??= (async () => {
        const loggedIn = params.get("logged_in_customer_id")?.trim();
        if (loggedIn) return loggedIn;
        if (!params.get("customer_sig")) return null;
        return verifiedCustomerId(
          await deps.customerSigningKey(shop),
          params.get("customer_id"),
          params.get("customer_ts"),
          params.get("customer_sig"),
          { now: deps.now() },
        );
      })();
      return customer;
    },
  };
}

export interface ProxyRouteContext extends AppProxyContext {
  /**
   * JSON with explicit caching. Public caching is refused for non-GET
   * requests and once the handler has read the customer.
   */
  json(
    body: unknown,
    init: { cache: CachePolicy; status?: number; headers?: HeadersInit },
  ): Response;
  /** A Liquid page (escape values with `liquidText`). No-store. */
  liquid(
    html: string,
    init?: { status?: number; layout?: boolean; headers?: HeadersInit },
  ): Response;
}

export interface ProxyRouteOptions {
  /** Fixed-window limits; omit for no throttling. */
  throttle?: ThrottleLimits;
  /** Answer shops without an offline session instead of a 404. */
  allowUninstalled?: boolean;
}

/**
 * Wraps an App Proxy loader/action: verify → 404 unless installed →
 * throttle → handler. Thrown Responses pass through to React Router.
 *
 *   export const loader = proxyRoute({ throttle: {...} }, async (ctx) =>
 *     ctx.json({ ok: true }, { cache: "no-store" }));
 */
export function proxyRoute(
  options: ProxyRouteOptions,
  handler: (ctx: ProxyRouteContext) => Promise<Response> | Response,
): (args: { request: Request }) => Promise<Response> {
  return async ({ request }) => {
    const deps = current;
    const ctx = await authenticateProxy(request, deps);
    if (!ctx.session && !options.allowUninstalled) {
      return jsonResponse(
        { ok: false, error: "Not found" },
        { cache: "no-store", status: 404 },
      );
    }
    if (options.throttle) {
      const limited = await throttle(request, ctx.shop, options.throttle, {
        store: deps.throttleStore,
        now: deps.now(),
      });
      if (limited) return limited;
    }
    const routeCtx = Object.create(ctx, {
      json: {
        value: (
          body: unknown,
          init: { cache: CachePolicy; status?: number; headers?: HeadersInit },
        ) => {
          if (init.cache !== "no-store") {
            if (ctx.readsCustomer) {
              throw new Error(
                "A response that read the customer can't be publicly cached.",
              );
            }
            if (request.method !== "GET" && request.method !== "HEAD") {
              throw new Error(`A ${request.method} response can't be cached.`);
            }
          }
          return jsonResponse(body, init);
        },
      },
      liquid: {
        value: (
          html: string,
          init: {
            status?: number;
            layout?: boolean;
            headers?: HeadersInit;
          } = {},
        ) => liquidResponse(html, { ...init, cache: "no-store" }),
      },
    }) as ProxyRouteContext;
    return handler(routeCtx);
  };
}
