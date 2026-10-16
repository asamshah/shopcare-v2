/** Signed unsubscribe tokens and Resend (Svix) webhook signatures. */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySvixSignature } from "../../../app/services/notifications/resend-webhook.server";
import {
  signUnsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from "../../../app/services/notifications/unsubscribe.server";

describe("unsubscribe tokens", () => {
  const claims = { shop: "acme.myshopify.com", email: "a@example.com", customerId: "77" };

  it("round-trips the shop, address and customer", () => {
    expect(verifyUnsubscribeToken(signUnsubscribeToken(claims))).toEqual(claims);
  });

  it("rejects a tampered or malformed token", () => {
    const token = signUnsubscribeToken(claims);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ s: "other.myshopify.com", e: "a@example.com", c: "77" })).toString("base64url");
    expect(verifyUnsubscribeToken(`${forged}.${sig}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${body}.${sig}x`)).toBeNull();
    expect(verifyUnsubscribeToken(`${body}`)).toBeNull();
    expect(verifyUnsubscribeToken(null)).toBeNull();
  });

  it("builds the link on the app URL, and none without an address", () => {
    const url = unsubscribeUrl("acme.myshopify.com", { customerId: "77", email: "a@example.com" }, "https://shopcare.test/");
    expect(url).toMatch(/^https:\/\/shopcare\.test\/email\/unsubscribe\?token=/);
    expect(verifyUnsubscribeToken(new URL(url!).searchParams.get("token"))).toEqual(claims);
    expect(unsubscribeUrl("acme.myshopify.com", { customerId: "77" }, "https://shopcare.test")).toBeNull();
  });
});

describe("verifySvixSignature", () => {
  const secretBytes = Buffer.from("resend-test-secret-0123456789");
  const secret = `whsec_${secretBytes.toString("base64")}`;
  const body = JSON.stringify({ type: "email.bounced" });
  const now = 1_760_000_000_000;
  const headersFor = (signature: string, timestamp = String(now / 1000)) =>
    new Headers({ "svix-id": "msg_1", "svix-timestamp": timestamp, "svix-signature": signature });
  const sign = (content: string) => createHmac("sha256", secretBytes).update(content).digest("base64");

  it("accepts a valid v1 signature, also among several", () => {
    const sig = sign(`msg_1.${now / 1000}.${body}`);
    expect(verifySvixSignature(body, headersFor(`v1,${sig}`), secret, now)).toBe(true);
    expect(verifySvixSignature(body, headersFor(`v1,AAAA v1,${sig}`), secret, now)).toBe(true);
  });

  it("rejects a wrong signature, a changed body, an old timestamp or no secret", () => {
    const sig = sign(`msg_1.${now / 1000}.${body}`);
    expect(verifySvixSignature(body, headersFor("v1,bm9wZQ=="), secret, now)).toBe(false);
    expect(verifySvixSignature(`${body} `, headersFor(`v1,${sig}`), secret, now)).toBe(false);
    expect(verifySvixSignature(body, headersFor(`v1,${sig}`), secret, now + 10 * 60_000)).toBe(false);
    expect(verifySvixSignature(body, headersFor(`v1,${sig}`), undefined, now)).toBe(false);
  });
});
