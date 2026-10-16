/**
 * POSTs an event payload to a merchant's configured outbound webhook URL, with
 * an HMAC-SHA256 signature (when a webhook secret is set) so the receiver can
 * verify it. Ported from Rails Repairs::WebhookDelivery.
 *
 * The URL is merchant-supplied and requested from our servers, so outside
 * development/test it must be https and every address it resolves to must be
 * public (SSRF guard). The connection is pinned to the address that was
 * checked, which defeats DNS rebinding, and redirects are never followed.
 *
 * Like Rails, delivery is best effort: failures are logged and `deliver`
 * returns null rather than throwing.
 */
import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const TIMEOUT_MS = 5000;
export const USER_AGENT = "ShopCare-Webhook/1.0";

export type Resolver = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;

/** Sends the request to `address` (already checked), keeping the URL's host for TLS and Host. */
export type Transport = (request: {
  url: URL;
  address: string | null;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ status: number }>;

export interface WebhookDeliveryOptions {
  secret?: string | null;
  /** Enforce https + public addresses. Default: on except in development and test. */
  strict?: boolean;
  resolve?: Resolver;
  transport?: Transport;
}

// Everything that isn't a public unicast address. One list per family: a
// BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules.
const internalV4 = new BlockList();
const internalV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  internalV4.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64
  ["100::", 64],
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  internalV6.addSubnet(network, prefix, "ipv6");
}

export function isInternalAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return family === 4
    ? internalV4.check(address, "ipv4")
    : internalV6.check(address, "ipv6");
}

function defaultStrict(): boolean {
  return !["development", "test"].includes(process.env.NODE_ENV ?? "");
}

const defaultResolver: Resolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

export type PermitResult =
  { ok: true; address: string | null } | { ok: false; reason: string };

/**
 * Whether the URL may be requested and, in strict mode, the checked address
 * to pin the connection to (the first one, provided every address is public).
 */
export async function checkWebhookUrl(
  url: string,
  {
    strict = defaultStrict(),
    resolve = defaultResolver,
  }: Pick<WebhookDeliveryOptions, "strict" | "resolve"> = {},
): Promise<PermitResult> {
  const parsed = parseUrl(url);
  if (
    !parsed ||
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname
  )
    return { ok: false, reason: "not an http(s) URL" };
  if (!strict) return { ok: true, address: null };
  if (parsed.protocol !== "https:") return { ok: false, reason: "not https" };
  if (parsed.username || parsed.password)
    return { ok: false, reason: "credentials in URL" };

  let addresses: { address: string }[];
  try {
    addresses = await resolve(bareHostname(parsed));
  } catch {
    return { ok: false, reason: "host doesn't resolve" };
  }
  if (addresses.length === 0)
    return { ok: false, reason: "host doesn't resolve" };
  if (addresses.some(({ address }) => isInternalAddress(address)))
    return { ok: false, reason: "resolves to a non-public address" };
  return { ok: true, address: addresses[0].address };
}

export async function permittedWebhookUrl(
  url: string,
  options?: Pick<WebhookDeliveryOptions, "strict" | "resolve">,
): Promise<boolean> {
  return (await checkWebhookUrl(url, options)).ok;
}

export function webhookSignature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function buildWebhookHeaders(
  body: string,
  { event, secret }: { event?: string | null; secret?: string | null },
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (event) headers["X-ShopCare-Event"] = event;
  if (secret) headers["X-ShopCare-Hmac-Sha256"] = webhookSignature(secret, body);
  return headers;
}

/** A `lookup` that always answers with the checked address. */
export function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/** node:http(s) request, pinned to `address` when given; never follows redirects. */
export const nodeTransport: Transport = ({ url, address, headers, body }) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        timeout: TIMEOUT_MS,
        ...(address ? { lookup: pinnedLookup(address) } : {}),
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
        response.on("error", reject);
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error(`timed out after ${TIMEOUT_MS}ms`)),
    );
    request.on("error", reject);
    request.end(body);
  });

export async function deliverWebhook(
  url: string,
  payload: { event?: string },
  {
    secret,
    strict,
    resolve,
    transport = nodeTransport,
  }: WebhookDeliveryOptions = {},
): Promise<{ status: number } | null> {
  const check = await checkWebhookUrl(url, { strict, resolve });
  if (!check.ok) {
    console.warn(`[webhook-delivery] blocked ${url}: ${check.reason}`);
    return null;
  }
  const body = JSON.stringify(payload);
  try {
    return await transport({
      url: new URL(url),
      address: check.address,
      headers: buildWebhookHeaders(body, {
        event: payload.event,
        secret: secret || null,
      }),
      body,
    });
  } catch (error) {
    console.error(`[webhook-delivery] POST ${url} failed: ${String(error)}`);
    return null;
  }
}
