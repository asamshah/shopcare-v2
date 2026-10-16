import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmailAdapter,
  EmailDeliveryError,
  fromAddress,
  LogEmailAdapter,
  MAX_ATTACHMENT_BYTES,
  ResendEmailAdapter,
  sendEmail,
  setEmailAdapter,
  type EmailMessage,
} from "../../app/services/email.server";

const message = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  shopId: "acme.myshopify.com",
  to: "sarah@example.com",
  subject: "We've received your repair request",
  html: "<p>Thanks</p>",
  text: "Thanks",
  replyTo: "help@acme.example",
  fromName: "Acme Boots via ShopCare",
  tags: { event: "repair_received" },
  idempotencyKey: "repair_received:ticket_1",
  ...overrides,
});

describe("sendEmail with the log adapter", () => {
  let log: LogEmailAdapter;

  beforeEach(() => {
    log = new LogEmailAdapter(true);
    setEmailAdapter(log);
  });
  afterEach(() => setEmailAdapter(undefined));

  it("captures the message with a resolved From header", async () => {
    const result = await sendEmail(message());

    expect(result).toEqual({ id: "log_1", adapter: "log" });
    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]).toMatchObject({
      from: '"Acme Boots via ShopCare" <notifications@mail.shopcare.test>',
      to: "sarah@example.com",
      replyTo: "help@acme.example",
      idempotencyKey: "repair_received:ticket_1",
      tags: { event: "repair_received" },
    });
  });

  it("requires an idempotency key and a recipient", async () => {
    await expect(sendEmail(message({ idempotencyKey: "" }))).rejects.toThrow(
      /idempotencyKey/,
    );
    await expect(sendEmail(message({ to: [] }))).rejects.toThrow(/recipient/);
    expect(log.sent).toHaveLength(0);
  });

  it("passes extra headers through, stripped of line breaks", async () => {
    await sendEmail(
      message({
        headers: { "List-Unsubscribe": "<https://x.test/u>\r\nBcc: z@y" },
      }),
    );
    expect(log.sent[0].headers).toEqual({
      "List-Unsubscribe": "<https://x.test/u> Bcc: z@y",
    });
  });

  it("keeps attachments with the captured message", async () => {
    const pdf = new Uint8Array([37, 80, 68, 70]);
    await sendEmail(
      message({ attachments: [{ filename: "slip.pdf", content: pdf, contentType: "application/pdf" }] }),
    );
    expect(log.sent[0].attachments).toEqual([
      { filename: "slip.pdf", content: pdf, contentType: "application/pdf" },
    ]);
  });

  it("refuses attachments over the size limit, without retrying", async () => {
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    const sending = sendEmail(
      message({ attachments: [{ filename: "big.pdf", content: big, contentType: "application/pdf" }] }),
    );
    await expect(sending).rejects.toBeInstanceOf(EmailDeliveryError);
    await expect(sending).rejects.toMatchObject({ retryable: false });
    expect(log.sent).toHaveLength(0);
  });

  it("can be cleared between assertions", async () => {
    await sendEmail(message());
    log.clear();
    expect(log.sent).toEqual([]);
  });
});

describe("fromAddress", () => {
  it("falls back to the default name and strips header-breaking characters", () => {
    expect(fromAddress()).toBe('"ShopCare" <notifications@mail.shopcare.test>');
    expect(fromAddress('Evil" <x@y>\r\nBcc: z')).toBe(
      '"Evil x@yBcc: z" <notifications@mail.shopcare.test>',
    );
  });
});

describe("createEmailAdapter", () => {
  it("builds the log adapter and refuses Resend without a key or unknown names", () => {
    expect(createEmailAdapter("log").name).toBe("log");
    const saved = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    expect(() => createEmailAdapter("resend")).toThrow(/RESEND_API_KEY/);
    process.env.RESEND_API_KEY = saved;
    expect(() => createEmailAdapter("carrier-pigeon")).toThrow(/Unknown/);
  });

  it("builds the Resend adapter when a key is given", () => {
    process.env.RESEND_API_KEY = "re_test";
    try {
      expect(createEmailAdapter("resend").name).toBe("resend");
    } finally {
      delete process.env.RESEND_API_KEY;
    }
  });
});

describe("ResendEmailAdapter", () => {
  it("sends attachments as Buffers with their content type", async () => {
    const adapter = new ResendEmailAdapter("re_test");
    const send = vi.fn(async () => ({ data: { id: "re_1" }, error: null }));
    (adapter as unknown as { client: unknown }).client = { emails: { send } };
    await adapter.send({
      ...message({
        attachments: [{ filename: "slip.pdf", content: new Uint8Array([1, 2]), contentType: "application/pdf" }],
      }),
      from: "x <n@mail.shopcare.test>",
    });
    const [payload, options] = send.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(payload.attachments).toEqual([
      { filename: "slip.pdf", content: Buffer.from([1, 2]), contentType: "application/pdf" },
    ]);
    expect(options).toEqual({ idempotencyKey: "repair_received:ticket_1" });
  });

  it("sends no attachments key for an ordinary email", async () => {
    const adapter = new ResendEmailAdapter("re_test");
    const send = vi.fn(async () => ({ data: { id: "re_2" }, error: null }));
    (adapter as unknown as { client: unknown }).client = { emails: { send } };
    await adapter.send({ ...message(), from: "x <n@mail.shopcare.test>" });
    expect(send.mock.calls[0]).toBeDefined();
    expect(Object.keys((send.mock.calls[0] as unknown as [Record<string, unknown>])[0])).not.toContain("attachments");
  });
});
