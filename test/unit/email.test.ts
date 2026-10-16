import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEmailAdapter,
  fromAddress,
  LogEmailAdapter,
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
