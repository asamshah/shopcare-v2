/**
 * Records a ShopCare event on a Klaviyo profile (Klaviyo Events API), so the
 * merchant can send it from a Klaviyo flow. Ported from Rails
 * Notifications::KlaviyoClient; an optional integration in v2.
 */
import { DeliveryError } from "./delivery-error.server";

export const KLAVIYO_ENDPOINT = "https://a.klaviyo.com/api/events";
export const KLAVIYO_REVISION = "2024-10-15";
const TIMEOUT_MS = 5000;

export interface KlaviyoEvent {
  metric: string;
  email: string;
  properties: Record<string, unknown>;
  uniqueId: string;
  time?: Date;
}

export class KlaviyoClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  buildRequest({
    metric,
    email,
    properties,
    uniqueId,
    time = new Date(),
  }: KlaviyoEvent): { url: string; init: RequestInit } {
    return {
      url: KLAVIYO_ENDPOINT,
      init: {
        method: "POST",
        headers: {
          Authorization: `Klaviyo-API-Key ${this.apiKey}`,
          revision: KLAVIYO_REVISION,
          accept: "application/vnd.api+json",
          "content-type": "application/vnd.api+json",
        },
        body: JSON.stringify({
          data: {
            type: "event",
            attributes: {
              properties,
              unique_id: uniqueId,
              time: time.toISOString(),
              metric: {
                data: { type: "metric", attributes: { name: metric } },
              },
              profile: { data: { type: "profile", attributes: { email } } },
            },
          },
        }),
      },
    };
  }

  async track(event: KlaviyoEvent): Promise<void> {
    const { url, init } = this.buildRequest(event);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new DeliveryError(`Klaviyo request failed: ${String(error)}`);
    }
    if (response.ok) return;
    const body = (await response.text().catch(() => "")).slice(0, 300);
    throw new DeliveryError(
      `Klaviyo ${response.status}: ${body}`,
      response.status === 429 || response.status >= 500,
    );
  }
}
