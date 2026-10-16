/**
 * Per-shop notification settings, as the notifications service needs them.
 *
 * Loaded from the Shop row by loadNotificationSettings()
 * (shop-settings.server.ts). Flow is off unless the merchant turns it on:
 * ShopCare works fully without it, and Flow and Klaviyo are optional
 * integrations for merchants who want their own staff or customer emails.
 */
export interface ShopNotificationSettings {
  /** The shop's myshopify domain (identifies the shop in deliveries and logs). */
  shopId: string;
  /** Optional integrations. */
  flowEnabled: boolean;
  klaviyoApiKey?: string | null;
  /**
   * Days after purchase the "Add Care" offer is emitted (by the daily
   * care-offers job). Default 7.
   */
  careOfferDelayDays?: number;
}
