import { useAppBridge } from "@shopify/app-bridge-react";

/** Shopify admin pages (App Bridge `shopify://admin/…` links). */
export const SHOPIFY_NOTIFICATIONS_URL = "shopify://admin/settings/notifications";
export const SHOPIFY_FLOW_URL = "shopify://admin/apps/flow";

/**
 * The ShopCare section for Shopify's Order confirmation email: a copy button,
 * where to paste it, and (optionally) a rendered preview.
 */
export function OrderConfirmationSnippet({
  snippet,
  previews,
}: {
  snippet: string;
  /** Rendered HTML of the sample repair and Care orders. */
  previews?: { label: string; html: string }[];
}) {
  const shopify = useAppBridge();

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      shopify.toast.show("Snippet copied");
    } catch {
      shopify.toast.show("Couldn't copy: select the code below and copy it", { isError: true });
    }
  }

  return (
    <s-stack direction="block" gap="small-200">
      <s-ordered-list>
        <s-list-item>Copy the ShopCare snippet.</s-list-item>
        <s-list-item>
          In Shopify, open{" "}
          <s-link href={SHOPIFY_NOTIFICATIONS_URL} target="_top">
            Settings → Notifications
          </s-link>{" "}
          → Customer notifications → Order confirmation → Edit code.
        </s-list-item>
        <s-list-item>Paste it where it should appear (for example just above the order summary) and save.</s-list-item>
      </s-ordered-list>
      <s-stack direction="inline" gap="small-200">
        <s-button variant="primary" icon="clipboard" onClick={copy}>
          Copy snippet
        </s-button>
        <s-button href={SHOPIFY_NOTIFICATIONS_URL} target="_top">
          Open Shopify notifications
        </s-button>
      </s-stack>
      <details>
        <summary style={{ cursor: "pointer" }}>Show the code</summary>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: "12px", maxHeight: "20rem", overflow: "auto" }}>{snippet}</pre>
      </details>
      {previews?.length ? (
        <details>
          <summary style={{ cursor: "pointer" }}>Preview</summary>
          <s-stack direction="block" gap="small-200">
            {previews.map((preview) => (
              <s-box key={preview.label} padding="small-200" border="base" border-radius="base">
                <s-text color="subdued">{preview.label}</s-text>
                {/* Rendered server-side from the snippet and sample data (escaped by the snippet itself). */}
                <div dangerouslySetInnerHTML={{ __html: preview.html }} />
              </s-box>
            ))}
          </s-stack>
        </details>
      ) : null}
    </s-stack>
  );
}
