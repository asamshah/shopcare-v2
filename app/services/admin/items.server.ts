/**
 * Items customers own, with their cover, tickets and registration (Rails
 * ItemsController, RegistrationsController).
 */
import type { Prisma, Shop } from "@prisma/client";
import prisma from "../../db.server";
import { enqueue } from "../../lib/background.server";
import type { JobName } from "../../jobs/registry.server";
import { settingsOf } from "../../models/shop.server";

export const ITEM_FILTERS = ["registrations", "unverified", "covered"] as const;

export interface ItemsDeps {
  /** Backfill Items from recent paid orders (the import-orders job). */
  enqueueImport: (shopId: number) => Promise<void>;
}

export const itemsDeps: ItemsDeps = {
  // STUB(w2-admin): the "import-orders" job (Rails ImportOrdersJob) is owned by
  // w2-backend; until it's in the registry this name doesn't typecheck as a JobName.
  enqueueImport: (shopId) => enqueue("import-orders" as JobName, { shopId }),
};

export async function startItemsImport(shop: Shop, deps: ItemsDeps = itemsDeps): Promise<void> {
  const settings = settingsOf(shop);
  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      settings: {
        ...settings,
        items_import: { status: "queued", at: new Date().toISOString() },
      } as Prisma.InputJsonValue,
    },
  });
  await deps.enqueueImport(shop.id);
}
