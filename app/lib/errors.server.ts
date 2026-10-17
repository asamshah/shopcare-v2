/**
 * Error reporting: `reportError(error, context)` logs the error and, when
 * SENTRY_DSN is set, sends it to Sentry. Without a DSN it only logs, so local
 * runs and tests send nothing anywhere.
 *
 * Called where a failure would otherwise sit unread in Netlify's function
 * logs: a background job that throws, a job that runs out of attempts, a
 * failed dispatch, and loader/action errors (`handleError` in
 * app/entry.server.tsx). Context is small and has no customer data: job
 * names and ids, shop domains, route paths. Payloads are never attached.
 *
 * Serverless functions can freeze as soon as they return, so callers that
 * finish the invocation `await reportError(…)`: it flushes (up to 2 s).
 */
import * as Sentry from "@sentry/node";

export type ErrorContext = Record<string, string | number | boolean | null | undefined>;

let initialised: boolean | undefined;

function sentryEnabled(): boolean {
  if (initialised !== undefined) return initialised;
  const dsn = process.env.SENTRY_DSN;
  initialised = Boolean(dsn) && !process.env.VITEST;
  if (initialised) {
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.CONTEXT || process.env.NODE_ENV,
      // Errors only: no tracing, no request bodies, no IPs or cookies.
      tracesSampleRate: 0,
      sendDefaultPii: false,
      defaultIntegrations: false,
    });
  }
  return initialised;
}

export async function reportError(error: unknown, context: ErrorContext = {}): Promise<void> {
  const where = Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.error(`[error] ${where}`, error);
  if (!sentryEnabled()) return;
  try {
    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(context)) {
        if (value !== undefined && value !== null) scope.setTag(key, String(value));
      }
      Sentry.captureException(error);
    });
    await Sentry.flush(2000);
  } catch (sentryError) {
    console.error("[error] couldn't report to Sentry", sentryError);
  }
}
