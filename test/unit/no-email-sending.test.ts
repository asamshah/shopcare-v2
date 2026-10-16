/**
 * Shopify sends every email; ShopCare has no email provider of its own.
 * Guards against the removed Resend machinery creeping back.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(ROOT, path)).isDirectory() ? files(path) : [path];
  });
}

const SOURCES = [...files("app"), ...files("netlify"), ...files("extensions"), "package.json", ".env.example", "prisma/schema.prisma", "shopify.app.toml"];

describe("no ShopCare email sending", () => {
  it.each([
    ["the Resend SDK or env vars", /from ["']resend["']|new Resend\(|RESEND_|resend\.com/],
    ["the email sender env vars", /EMAIL_FROM_DOMAIN|EMAIL_DEFAULT_FROM_NAME|EMAIL_ADAPTER/],
    ["the suppression list", /email_suppressions|EmailSuppression|isEmailSuppressed/],
    ["unsubscribe links", /email\.unsubscribe|unsubscribeUrl|List-Unsubscribe/],
    ["the email and staff_email channels", /channel: "email"|"staff_email"/],
    ["ShopCare email templates", /renderEmail|sendEmail\(/],
  ])("has no %s left", (_what, pattern) => {
    const hits = SOURCES.filter((file) =>
      readFileSync(join(ROOT, file), "utf8")
        .split("\n")
        .some((line) => pattern.test(line)),
    );
    expect(hits).toEqual([]);
  });

  it("removed the email routes and modules", () => {
    for (const path of [
      "app/services/email.server.ts",
      "app/routes/webhooks.email.tsx",
      "app/routes/email.unsubscribe.tsx",
      "app/services/notifications/templates.server.ts",
      "app/services/notifications/suppressions.server.ts",
      "app/jobs/marketing-unsubscribe.server.ts",
    ])
      expect(existsSync(join(ROOT, path)), path).toBe(false);
  });

  it("depends on no email provider", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /resend|postmark|sendgrid|nodemailer|mailgun/i.test(d))).toEqual([]);
  });
});
