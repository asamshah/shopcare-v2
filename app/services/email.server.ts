/**
 * Outbound email, independent of the provider.
 *
 * ShopCare sends its own customer and staff emails (see "Notifications (v2
 * design)" in docs/PORTING.md). Callers only use `sendEmail()` and the types
 * here. Provider SDK types stay inside the adapters, so Resend can be swapped
 * for Postmark or SES by adding an adapter.
 *
 * Adapters (EMAIL_ADAPTER):
 *   resend  default when RESEND_API_KEY is set
 *   log     default otherwise (dev/test): prints a one-line summary and keeps
 *           every message in memory so tests can assert on it
 *
 * This module only delivers mail. Templates, per-shop settings, consent checks
 * and the notification_deliveries idempotency record belong to the
 * notifications service that calls it.
 */
import { Resend } from "resend";

export interface EmailMessage {
  /** The shop the email is sent for (used for tagging and logs). */
  shopId: string;
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  /** Usually the merchant's support address. */
  replyTo?: string;
  /** Display name, e.g. "Acme Boots via ShopCare". */
  fromName?: string;
  /** Provider tags for analytics/webhooks, e.g. { event: "repair_received" }. */
  tags?: Record<string, string>;
  /** Stable per event, e.g. "repair_received:ticket_123"; providers drop repeats. */
  idempotencyKey: string;
}

export interface EmailResult {
  /** The provider's message id. */
  id: string;
  adapter: string;
}

export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    /** True for rate limits, 5xx and network errors, which are worth retrying. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

/** An adapter turns a message with a resolved `from` header into a delivery. */
export interface EmailAdapter {
  readonly name: string;
  send(message: EmailMessage & { from: string }): Promise<EmailResult>;
}

// ---------------------------------------------------------------------------
// From header

/** Strips characters that could break out of a quoted display name or header. */
function sanitizeDisplayName(name: string): string {
  return name.replace(/[\r\n"<>\\]/g, "").trim();
}

export function fromAddress(fromName?: string): string {
  const domain = process.env.EMAIL_FROM_DOMAIN || "localhost";
  const name = sanitizeDisplayName(
    fromName || process.env.EMAIL_DEFAULT_FROM_NAME || "ShopCare",
  );
  return `"${name}" <notifications@${domain}>`;
}

// ---------------------------------------------------------------------------
// Adapters

/** Captures messages in memory and logs a summary. For dev and tests. */
export class LogEmailAdapter implements EmailAdapter {
  readonly name = "log";
  readonly sent: (EmailMessage & { from: string; id: string })[] = [];

  constructor(private readonly quiet = false) {}

  async send(message: EmailMessage & { from: string }): Promise<EmailResult> {
    const id = `log_${this.sent.length + 1}`;
    this.sent.push({ ...message, id });
    if (!this.quiet) {
      console.info(
        `[email:log] ${id} to=${[message.to].flat().join(",")} subject=${JSON.stringify(message.subject)} key=${message.idempotencyKey}`,
      );
    }
    return { id, adapter: this.name };
  }

  clear() {
    this.sent.length = 0;
  }
}

export class ResendEmailAdapter implements EmailAdapter {
  readonly name = "resend";
  private readonly client: Resend;

  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage & { from: string }): Promise<EmailResult> {
    const tags = Object.entries({ shop: message.shopId, ...message.tags }).map(
      ([name, value]) => ({
        name,
        value: value.replace(/[^A-Za-z0-9_-]/g, "_"),
      }),
    );
    let response;
    try {
      response = await this.client.emails.send(
        {
          from: message.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          replyTo: message.replyTo,
          tags,
        },
        { idempotencyKey: message.idempotencyKey },
      );
    } catch (error) {
      throw new EmailDeliveryError(
        `Resend request failed: ${String(error)}`,
        true,
      );
    }
    if (response.error) {
      const status = response.error.statusCode;
      const retryable = status === null || status === 429 || status >= 500;
      throw new EmailDeliveryError(
        `Resend: ${response.error.message}`,
        retryable,
      );
    }
    return { id: response.data.id, adapter: this.name };
  }
}

// ---------------------------------------------------------------------------
// Selection

export function createEmailAdapter(
  name = process.env.EMAIL_ADAPTER ||
    (process.env.RESEND_API_KEY ? "resend" : "log"),
): EmailAdapter {
  switch (name) {
    case "resend": {
      const key = process.env.RESEND_API_KEY;
      if (!key) throw new Error("EMAIL_ADAPTER=resend needs RESEND_API_KEY.");
      return new ResendEmailAdapter(key);
    }
    case "log":
      return new LogEmailAdapter(Boolean(process.env.VITEST));
    default:
      throw new Error(`Unknown EMAIL_ADAPTER: ${name}`);
  }
}

let adapter: EmailAdapter | undefined;

export function getEmailAdapter(): EmailAdapter {
  adapter ??= createEmailAdapter();
  return adapter;
}

/** Replaces the app-wide adapter. Tests pass a LogEmailAdapter; pass undefined to reset. */
export function setEmailAdapter(next: EmailAdapter | undefined) {
  adapter = next;
}

/** Sends one email through the configured adapter. Throws EmailDeliveryError on failure. */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  if (!message.idempotencyKey)
    throw new Error("sendEmail needs an idempotencyKey.");
  if ([message.to].flat().length === 0)
    throw new Error("sendEmail needs a recipient.");
  return getEmailAdapter().send({
    ...message,
    from: fromAddress(message.fromName),
  });
}
