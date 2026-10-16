/**
 * Rails flash messages for the embedded admin. Session cookies are unreliable
 * inside the admin iframe, so the message rides on the redirect URL
 * (`?notice=` / `?alert=`); the app layout shows it as an App Bridge toast and
 * then drops it from the URL (app/components/flash-toast.tsx).
 */
import { redirect } from "react-router";

export interface Flash {
  notice?: string;
  alert?: string;
}

export const FLASH_PARAMS = ["notice", "alert"] as const;

export function flashUrl(path: string, flash: Flash = {}): string {
  const url = new URL(path, "http://admin.invalid");
  for (const key of FLASH_PARAMS) {
    url.searchParams.delete(key);
    const message = flash[key];
    if (message) url.searchParams.set(key, message);
  }
  return `${url.pathname}${url.search}`;
}

/** `redirect_to path, notice: …` / `alert: …`. */
export function redirectWithFlash(path: string, flash: Flash = {}): Response {
  return redirect(flashUrl(path, flash));
}
