import { useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

/**
 * Downloads a CSV from an admin route. A plain link would load inside the
 * admin iframe without a session token; fetch() from the embedded app is
 * authenticated by App Bridge, so fetch the file and save it as a blob.
 */
export function DownloadButton({
  href,
  children,
  variant,
  slot,
}: {
  /** The URL, or a function giving it at click time. */
  href: string | (() => string);
  children: string;
  variant?: "primary" | "secondary" | "tertiary";
  slot?: "primary-action" | "secondary-actions";
}) {
  const shopify = useAppBridge();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const response = await fetch(typeof href === "function" ? href() : href);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "download.csv";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      shopify.toast.show(`Download failed: ${(error as Error).message}`, { isError: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <s-button
      onClick={download}
      {...(variant ? { variant } : {})}
      {...(slot ? { slot } : {})}
      {...(busy ? { loading: true } : {})}
    >
      {children}
    </s-button>
  );
}
