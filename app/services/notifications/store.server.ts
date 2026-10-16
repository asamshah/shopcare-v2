/**
 * Where notification deliveries are recorded: the idempotency record and the
 * log merchants see in Settings (Rails `notification_deliveries`).
 *
 * Implementations: `PrismaNotificationStore` (prisma-store.server.ts, the
 * production default, table `notification_deliveries` with a unique
 * (shop_id, channel, idempotency_key)) and `InMemoryNotificationStore` below
 * (unit tests).
 *
 * `claim` is INSERT … ON CONFLICT (shop_id, channel, idempotency_key) DO
 * NOTHING, then SELECT the row (Prisma: create, catch P2002, findUnique), so a
 * duplicate webhook or retry finds the existing row and stops.
 */
import type { Channel, EventData, EventName } from "./events.server";

export type DeliveryStatus = "pending" | "sent" | "skipped" | "failed";

export interface DeliveryRecipient {
  /** Shopify customer id (numeric or GID); null for guests. */
  customerId?: string | null;
  email?: string | null;
  name?: string | null;
}

export interface DeliveryPayload<E extends EventName = EventName> {
  recipient: DeliveryRecipient;
  data: EventData[E];
}

export interface NotificationDelivery<E extends EventName = EventName> {
  id: string;
  shopId: string;
  event: E;
  channel: Channel;
  status: DeliveryStatus;
  idempotencyKey: string;
  payload: DeliveryPayload<E>;
  attempts: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClaimInput {
  shopId: string;
  event: EventName;
  channel: Channel;
  idempotencyKey: string;
  payload: DeliveryPayload;
}

export interface NotificationStore {
  /** Inserts a pending delivery, or returns the existing one with the same (shop, channel, key). */
  claim(
    input: ClaimInput,
  ): Promise<{ delivery: NotificationDelivery; created: boolean }>;
  find(id: string): Promise<NotificationDelivery | null>;
  markSent(id: string): Promise<void>;
  markSkipped(id: string, reason: string): Promise<void>;
  /**
   * Records a failed attempt (attempts + 1, error). `final` marks the delivery
   * failed; otherwise it stays pending for the retry.
   */
  markFailed(
    id: string,
    error: string,
    options: { final: boolean },
  ): Promise<{ attempts: number }>;
}

const ERROR_LIMIT = 500;

/** Keeps deliveries in memory. Tests and local experiments only. */
export class InMemoryNotificationStore implements NotificationStore {
  readonly deliveries = new Map<string, NotificationDelivery>();
  private nextId = 1;

  async claim(input: ClaimInput) {
    const existing = [...this.deliveries.values()].find(
      (d) =>
        d.shopId === input.shopId &&
        d.channel === input.channel &&
        d.idempotencyKey === input.idempotencyKey,
    );
    if (existing)
      return { delivery: structuredClone(existing), created: false };

    const now = new Date();
    const delivery: NotificationDelivery = {
      id: String(this.nextId++),
      ...structuredClone(input),
      status: "pending",
      attempts: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deliveries.set(delivery.id, delivery);
    return { delivery: structuredClone(delivery), created: true };
  }

  async find(id: string) {
    const delivery = this.deliveries.get(id);
    return delivery ? structuredClone(delivery) : null;
  }

  async markSent(id: string) {
    this.update(id, { status: "sent", error: null });
  }

  async markSkipped(id: string, reason: string) {
    this.update(id, { status: "skipped", error: reason });
  }

  async markFailed(id: string, error: string, { final }: { final: boolean }) {
    const delivery = this.get(id);
    const attempts = delivery.attempts + 1;
    this.update(id, {
      attempts,
      error: error.slice(0, ERROR_LIMIT),
      status: final ? "failed" : "pending",
    });
    return { attempts };
  }

  /** All deliveries, oldest first. */
  all(): NotificationDelivery[] {
    return [...this.deliveries.values()].map((d) => structuredClone(d));
  }

  private get(id: string): NotificationDelivery {
    const delivery = this.deliveries.get(id);
    if (!delivery) throw new Error(`No notification delivery ${id}`);
    return delivery;
  }

  private update(id: string, changes: Partial<NotificationDelivery>) {
    Object.assign(this.get(id), changes, { updatedAt: new Date() });
  }
}
