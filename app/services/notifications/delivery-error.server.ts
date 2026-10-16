/**
 * Raised when Flow or Klaviyo rejects a notification (Rails
 * Notifications::DeliveryError). `retryable` is true for rate limits, 5xx and
 * network errors; the notification job rethrows those so the background
 * function retries.
 */
export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}
