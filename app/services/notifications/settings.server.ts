/**
 * Per-shop notification settings, as the notifications service needs them.
 *
 * TODO(integration): load this from the Shop row (see the Settings section of
 * "Notifications (v2 design)" in docs/PORTING.md). The loader decides defaults
 * that depend on the database, such as `flowEnabled` for shops migrated from
 * Rails (where Flow was on unless switched off) and `supportEmail` falling
 * back to `shop { contactEmail }`.
 */
import { EMAIL_KINDS, type EmailKind } from "./events.server";

export interface EmailSettings {
  /** Defaults to on, except the marketing "Add Care" email, which is opt-in. */
  enabled?: boolean;
  /** Merchant-edited subject; placeholders like {{ticket_number}} are filled in. */
  subject?: string | null;
  /** Merchant-edited intro paragraph(s); same placeholders. */
  intro?: string | null;
}

export interface ShopNotificationSettings {
  /** The shop's myshopify domain (the `shopId` used for email tags and logs). */
  shopId: string;
  shopName: string;
  /** https URL of the logo shown in the email header (shop.brand or an upload). */
  logoUrl?: string | null;
  /** Button/heading accent, a hex colour such as "#bd4a27". */
  accentColor?: string | null;
  /** Postal address lines for the footer (shop.billingAddress or a Settings value). */
  addressLines?: string[] | null;
  /** Storefront URL, linked from the footer. */
  storeUrl?: string | null;
  /** Reply-To for every email. */
  supportEmail?: string | null;
  /** "Notify staff at": where staff alerts go. */
  staffEmail?: string | null;
  /** BCP 47 locale for dates and money, default "en". */
  locale?: string | null;
  emails?: Partial<Record<EmailKind, EmailSettings>>;
  /** Optional integrations. */
  flowEnabled: boolean;
  klaviyoApiKey?: string | null;
}

const OFF_BY_DEFAULT: readonly EmailKind[] = ["care_offer"];

export function isEmailEnabled(
  settings: ShopNotificationSettings,
  kind: EmailKind,
): boolean {
  return settings.emails?.[kind]?.enabled ?? !OFF_BY_DEFAULT.includes(kind);
}

/** Every email's effective on/off state, for the Settings page. */
export function emailToggles(
  settings: ShopNotificationSettings,
): Record<EmailKind, boolean> {
  return Object.fromEntries(
    EMAIL_KINDS.map((kind) => [kind, isEmailEnabled(settings, kind)]),
  ) as Record<EmailKind, boolean>;
}
