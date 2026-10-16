/**
 * Fixture builders, the TypeScript counterpart of the Rails
 * test/support/*_fixtures.rb modules: `build*` returns attributes with
 * sensible defaults, `create*` saves them. Override only what a test cares
 * about. Add a builder per model as the domain schema is ported (shop, repair
 * ticket, quotation, care plan, …).
 */
import type { Prisma, Session } from "@prisma/client";
import prisma from "../../app/db.server";

let sequence = 0;
/** A unique number per call, for ids and shop domains that must not collide. */
export const nextId = () => ++sequence;

export function buildSession(
  overrides: Partial<Prisma.SessionCreateInput> = {},
): Prisma.SessionCreateInput {
  const shop = overrides.shop ?? `shop-${nextId()}.myshopify.com`;
  return {
    id: `offline_${shop}`,
    shop,
    state: "state",
    isOnline: false,
    scope: "read_products",
    accessToken: "shpat_test_token",
    ...overrides,
  };
}

export function createSession(
  overrides: Partial<Prisma.SessionCreateInput> = {},
): Promise<Session> {
  return prisma.session.create({ data: buildSession(overrides) });
}
