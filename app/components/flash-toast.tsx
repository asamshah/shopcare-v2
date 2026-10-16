import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

/**
 * Rails flash → App Bridge toast. Actions redirect with ?notice= / ?alert=
 * (app/services/admin/flash.server.ts); this shows it once and removes it
 * from the URL so a reload doesn't repeat it.
 */
export function FlashToast() {
  const shopify = useAppBridge();
  const [params, setParams] = useSearchParams();
  const notice = params.get("notice");
  const alert = params.get("alert");

  useEffect(() => {
    if (!notice && !alert) return;
    if (notice) shopify.toast.show(notice);
    if (alert) shopify.toast.show(alert, { isError: true });
    const next = new URLSearchParams(params);
    next.delete("notice");
    next.delete("alert");
    setParams(next, { replace: true, preventScrollReset: true });
  }, [notice, alert, params, setParams, shopify]);

  return null;
}
