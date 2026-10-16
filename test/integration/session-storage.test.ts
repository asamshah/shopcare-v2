import { describe, expect, it } from "vitest";
import { Session } from "@shopify/shopify-api";
import prisma from "../../app/db.server";
import { sessionStorage } from "../../app/shopify.server";
import { createSession } from "../support/factories";

describe("Prisma session storage on Postgres", () => {
  it("stores, loads and deletes a Shopify session", async () => {
    const session = new Session({
      id: "offline_acme.myshopify.com",
      shop: "acme.myshopify.com",
      state: "state",
      isOnline: false,
      scope: "read_products",
      accessToken: "shpat_abc",
    });

    expect(await sessionStorage.storeSession(session)).toBe(true);
    const loaded = await sessionStorage.loadSession(session.id);
    expect(loaded?.shop).toBe("acme.myshopify.com");
    expect(loaded?.accessToken).toBe("shpat_abc");

    await sessionStorage.deleteSession(session.id);
    expect(await sessionStorage.loadSession(session.id)).toBeUndefined();
  });

  it("starts every test with an empty database", async () => {
    expect(await prisma.session.count()).toBe(0);
    await createSession();
    expect(await prisma.session.count()).toBe(1);
  });

  it("really did reset after the previous test", async () => {
    expect(await prisma.session.count()).toBe(0);
  });
});
