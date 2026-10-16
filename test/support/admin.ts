/**
 * Calling admin route loaders and actions as an authenticated merchant (the
 * Rails `setup_shopify_session` + `get`/`post` integration helpers).
 *
 *   const restore = signInAs(shop);            // or signInAs(shop, { admin: fakeGraphql })
 *   const res = await post(action, "/app/tickets/1", { intent: "note", body: "Hi" }, { id: "1" });
 *   expect(flash(res)).toEqual({ path: "/app/tickets/1", notice: "Note added." });
 *
 * `signInAs` swaps `authenticate.admin` (configureAdminAuth) for the shop's
 * domain, so routes run their real code against Postgres. Thrown responses
 * (redirects, 404s) are returned, as a browser would see them.
 */
import type { Shop } from "@prisma/client";
import { afterEach } from "vitest";
import { configureAdminAuth } from "../../app/services/admin/context.server";
import type { AdminGraphqlClient } from "../../app/shopify/graphql.server";
import { FakeGraphql } from "./fake-graphql";

let restores: (() => void)[] = [];

afterEach(() => {
  for (const restore of restores.reverse()) restore();
  restores = [];
});

export function signInAs(
  shop: Pick<Shop, "shopifyDomain">,
  { admin = new FakeGraphql() }: { admin?: AdminGraphqlClient } = {},
): AdminGraphqlClient {
  restores.push(configureAdminAuth(async () => ({ shopDomain: shop.shopifyDomain, admin })));
  return admin;
}

/** A request the admin authenticator would reject (no session). */
export function signedOut(): void {
  restores.push(
    configureAdminAuth(async () => {
      throw new Response(null, { status: 302, headers: { Location: "/auth/login" } });
    }),
  );
}

type RouteArgs = { request: Request; params: Record<string, string>; context: unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteFn = (args: any) => unknown;

const BASE = "https://shopcare.test";

async function run(fn: RouteFn, args: RouteArgs): Promise<unknown> {
  try {
    return await fn(args);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

/** Runs a loader for GET `path`; returns its data, or the Response it returned/threw. */
export function get<T = unknown>(loader: RouteFn, path: string, params: Record<string, string> = {}): Promise<T> {
  return run(loader, { request: new Request(BASE + path), params, context: {} }) as Promise<T>;
}

export type FormFields = Record<string, string | string[] | File>;

export function formData(fields: FormFields): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) form.append(key, v);
  }
  return form;
}

/** Runs an action for a form POST to `path`. */
export function post<T = unknown>(
  action: RouteFn,
  path: string,
  fields: FormFields = {},
  params: Record<string, string> = {},
): Promise<T> {
  const request = new Request(BASE + path, { method: "POST", body: formData(fields) });
  return run(action, { request, params, context: {} }) as Promise<T>;
}

/** A redirect's path and flash ({ path, notice?, alert? }), like Rails `assert_redirected_to` + `flash`. */
export function flash(response: unknown): { path: string; notice?: string; alert?: string } {
  if (!(response instanceof Response) || ![301, 302, 303, 307, 308].includes(response.status)) {
    throw new Error(`Expected a redirect, got ${response instanceof Response ? response.status : typeof response}`);
  }
  const url = new URL(response.headers.get("Location") ?? "", BASE);
  const notice = url.searchParams.get("notice") ?? undefined;
  const alert = url.searchParams.get("alert") ?? undefined;
  url.searchParams.delete("notice");
  url.searchParams.delete("alert");
  return {
    path: url.pathname + url.search,
    ...(notice ? { notice } : {}),
    ...(alert ? { alert } : {}),
  };
}

/** The HTTP status a loader/action result would have (200 for plain data). */
export function statusOf(result: unknown): number {
  if (result instanceof Response) return result.status;
  const init = (result as { type?: string; init?: { status?: number } } | null)?.init;
  if ((result as { type?: string } | null)?.type === "DataWithResponseInit") return init?.status ?? 200;
  return 200;
}

/** The data of a loader/action result, unwrapping `data(value, init)`. */
export function dataOf<T>(result: unknown): T {
  const wrapped = result as { type?: string; data?: unknown } | null;
  return (wrapped?.type === "DataWithResponseInit" ? wrapped.data : result) as T;
}
