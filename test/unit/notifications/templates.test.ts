import { describe, expect, it } from "vitest";
import {
  EMAIL_KINDS,
  type EmailKind,
} from "../../../app/services/notifications/events.server";
import {
  escapeHtml,
  fillPlaceholders,
  placeholdersFor,
  renderEmail,
  safeUrl,
  type EmailData,
} from "../../../app/services/notifications/templates.server";
import { buildSettings, sampleEmailData } from "../../support/notifications";

const UNSUBSCRIBE = "https://shopcare.test/unsubscribe?token=abc";

function render<K extends EmailKind>(
  kind: K,
  data: EmailData[K] = sampleEmailData[kind],
  settings = buildSettings(),
) {
  return renderEmail(kind, data, { settings, unsubscribeUrl: UNSUBSCRIBE });
}

describe("email templates", () => {
  it.each(EMAIL_KINDS)("%s matches its snapshot", (kind) => {
    const { subject, html, text } = render(kind);
    expect(subject).toMatchSnapshot("subject");
    expect(text).toMatchSnapshot("text");
    expect(html).toMatchSnapshot("html");
  });

  it.each(["assessing", "in_repair", "ready", "completed"] as const)(
    "repair status %s has its own subject and heading",
    (status) => {
      const { subject, text } = render("repair_status_changed", {
        ...sampleEmailData.repair_status_changed,
        status,
      });
      expect({
        subject,
        firstLines: text.split("\n").slice(0, 5),
      }).toMatchSnapshot();
    },
  );

  it("is accessible and mobile-friendly", () => {
    const { html } = render("repair_received");
    expect(html).toContain('<html lang="en-GB">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('alt="Acme Boots"');
    expect(html).toContain("max-width:600px");
    expect(html).toMatch(/<th scope="row"/);
    // Layout tables are marked presentational for screen readers.
    expect(html.match(/<table(?![^>]*role="presentation")/g)).toBeNull();
  });

  it("uses the shop's branding, and falls back when it is unusable", () => {
    const branded = render("care_welcome").html;
    expect(branded).toContain("border-bottom:3px solid #bd4a27");

    const plain = render(
      "repair_received",
      undefined,
      buildSettings({
        logoUrl: "javascript:alert(1)",
        accentColor: "red; background:url(x)",
        storeUrl: null,
      }),
    ).html;
    expect(plain).not.toContain("javascript:");
    expect(plain).not.toContain("<img");
    expect(plain).toContain(
      '<span style="font-size:20px;font-weight:600;color:#1f1f1f;">Acme Boots</span>',
    );
    expect(plain).toContain("border-bottom:3px solid #1a1a1a");
    expect(plain).not.toContain("url(x)");
  });

  it("picks button text that contrasts with the accent", () => {
    const light = render(
      "repair_received",
      undefined,
      buildSettings({ accentColor: "#ffd60a" }),
    );
    expect(light.html).toContain("color:#111111;text-decoration:none");
    const dark = render(
      "repair_received",
      undefined,
      buildSettings({ accentColor: "#123" }),
    );
    expect(dark.html).toContain("color:#ffffff;text-decoration:none");
  });

  it("puts the store's name and address in every footer", () => {
    for (const kind of EMAIL_KINDS) {
      const { html, text } = render(kind);
      expect(html).toContain(
        "1 Cobbler Lane<br>Northampton NN1 1AA<br>United Kingdom",
      );
      expect(text).toContain("Acme Boots\n1 Cobbler Lane\nNorthampton NN1 1AA");
    }
  });

  it("adds an unsubscribe link to the marketing email only", () => {
    expect(render("care_offer").html).toContain(
      `href="${escapeHtml(UNSUBSCRIBE)}"`,
    );
    expect(render("care_offer").text).toContain(`Unsubscribe: ${UNSUBSCRIBE}`);
    for (const kind of EMAIL_KINDS.filter((k) => k !== "care_offer")) {
      expect(render(kind).html).not.toMatch(/unsubscribe/i);
    }
    expect(() =>
      renderEmail("care_offer", sampleEmailData.care_offer, {
        settings: buildSettings(),
      }),
    ).toThrow(/unsubscribe/);
  });

  it("uses the merchant's subject and intro, with placeholders", () => {
    const settings = buildSettings({
      emails: {
        repair_status_changed: {
          subject: "{{store}}: repair {{ticket_number}} is {{status}} {{nope}}",
          intro: "Hello {{first_name}}!\n\nSecond paragraph.",
        },
      },
    });
    const { subject, html, text } = render(
      "repair_status_changed",
      undefined,
      settings,
    );
    expect(subject).toBe("Acme Boots: repair 42 is Ready");
    expect(html).toContain(">Hello Sarah!</p>");
    expect(html).toContain(">Second paragraph.</p>");
    expect(text).toContain("Hello Sarah!\n\nSecond paragraph.");
  });

  it("escapes customer and merchant text everywhere", () => {
    const evil = '<script>alert("x")</script>';
    const settings = buildSettings({
      shopName: `Acme ${evil}`,
      addressLines: [`<b>1</b> Lane`],
      emails: {
        repair_received: {
          subject: "New {{customer_name}}\r\nBcc: x@y.z",
          intro: `Hi {{customer_name}} ${evil}`,
        },
      },
    });
    const { subject, html } = render(
      "repair_received",
      {
        ...sampleEmailData.repair_received,
        customerName: `Sam ${evil}`,
        productTitle: `Boot" onmouseover="x`,
        description: `<img src=x onerror=alert(1)>`,
        statusUrl: `https://acme.example/?a="><script>`,
      },
      settings,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>1</b>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(subject).not.toMatch(/[\r\n]/);
  });
});

describe("helpers", () => {
  it("safeUrl only allows http(s)", () => {
    expect(safeUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,x")).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });

  it("fillPlaceholders ignores case and blanks unknown tokens", () => {
    expect(fillPlaceholders("{{ Store }}-{{x}}", { store: "A" })).toBe("A-");
  });

  it("lists the placeholders each email accepts", () => {
    expect(
      placeholdersFor(
        "staff_quote_declined",
        sampleEmailData.staff_quote_declined,
      ),
    ).toEqual([
      "store",
      "ticket_number",
      "product",
      "customer_name",
      "customer_email",
      "quote_total",
      "reason",
    ]);
  });
});
