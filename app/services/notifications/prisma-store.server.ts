/**
 * The NotificationStore on Postgres (`notification_deliveries`). The
 * notification service identifies shops by myshopify domain and deliveries by
 * string id; the table uses integer ids, so this translates both ways.
 *
 * `claim` inserts the pending row; when the unique (shop_id, channel,
 * idempotency_key) index says it already exists (a duplicate webhook, a
 * retried request), it returns that row with `created: false`.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Db } from "../../lib/db-lock.server";
import { createNotificationDelivery } from "../../models/notification-delivery.server";
import type { Channel, EventName } from "./events.server";
import type {
  ClaimInput,
  DeliveryPayload,
  DeliveryStatus,
  NotificationDelivery,
  NotificationStore,
} from "./store.server";

const ERROR_LIMIT = 500;

type Row = Prisma.NotificationDeliveryGetPayload<{
  include: { shop: { select: { shopifyDomain: true } } };
}>;

const WITH_SHOP = { shop: { select: { shopifyDomain: true } } } as const;

function toDelivery(row: Row): NotificationDelivery {
  return {
    id: String(row.id),
    shopId: row.shop.shopifyDomain,
    event: row.event as EventName,
    channel: row.channel as Channel,
    status: row.status as DeliveryStatus,
    idempotencyKey: row.idempotencyKey ?? "",
    payload: row.payload as unknown as DeliveryPayload,
    attempts: row.attempts,
    error: row.error,
    providerMessageId: row.providerMessageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Ids from the service are strings; anything non-numeric matches no row. */
function rowId(id: string): number | null {
  return /^\d+$/.test(id) ? Number(id) : null;
}

export class PrismaNotificationStore implements NotificationStore {
  constructor(private db: Db | PrismaClient) {}

  async claim(input: ClaimInput) {
    const shop = await this.db.shop.findUnique({
      where: { shopifyDomain: input.shopId },
      select: { id: true },
    });
    if (!shop) throw new Error(`No shop ${input.shopId} for a notification`);

    try {
      const created = await createNotificationDelivery(
        {
          shopId: shop.id,
          event: input.event,
          channel: input.channel,
          idempotencyKey: input.idempotencyKey,
          payload: input.payload as unknown as Prisma.InputJsonValue,
          status: "pending",
        },
        this.db,
      );
      const row = await this.db.notificationDelivery.findUniqueOrThrow({
        where: { id: created.id },
        include: WITH_SHOP,
      });
      return { delivery: toDelivery(row), created: true };
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      )
        throw error;
      const existing = await this.db.notificationDelivery.findFirstOrThrow({
        where: {
          shopId: shop.id,
          channel: input.channel,
          idempotencyKey: input.idempotencyKey,
        },
        include: WITH_SHOP,
      });
      return { delivery: toDelivery(existing), created: false };
    }
  }

  async find(id: string) {
    const key = rowId(id);
    if (key === null) return null;
    const row = await this.db.notificationDelivery.findUnique({
      where: { id: key },
      include: WITH_SHOP,
    });
    return row ? toDelivery(row) : null;
  }

  async markSent(id: string, providerMessageId?: string | null) {
    await this.update(id, {
      status: "sent",
      error: null,
      providerMessageId: providerMessageId ?? null,
    });
  }

  async markSkipped(id: string, reason: string) {
    await this.update(id, {
      status: "skipped",
      error: reason.slice(0, ERROR_LIMIT),
    });
  }

  async markFailed(id: string, error: string, { final }: { final: boolean }) {
    const row = await this.update(id, {
      attempts: { increment: 1 },
      error: error.slice(0, ERROR_LIMIT),
      status: final ? "failed" : "pending",
    });
    return { attempts: row.attempts };
  }

  private update(id: string, data: Prisma.NotificationDeliveryUpdateInput) {
    const key = rowId(id);
    if (key === null) throw new Error(`No notification delivery ${id}`);
    return this.db.notificationDelivery.update({ where: { id: key }, data });
  }
}
