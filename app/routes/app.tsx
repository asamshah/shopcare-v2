import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { FlashToast } from "../components/flash-toast";
import { SubmitOnEnter } from "../components/submit-on-enter";
import { partsEnabled, tradeInEnabled } from "../models/shop.server";
import { requireAdmin } from "../services/admin/context.server";

// The embedded admin layout (Rails layouts/embedded_app): App Bridge nav,
// flash messages as toasts. Every child route authenticates again itself.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireAdmin(request);
  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    partsEnabled: partsEnabled(shop),
    tradeInEnabled: tradeInEnabled(shop),
  };
};

export default function App() {
  const { apiKey, partsEnabled, tradeInEnabled } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        {/* rel isn't in the Link types yet; App Bridge reads it. */}
        <s-link href="/app" {...({ rel: "home" } as object)}>
          ShopCare
        </s-link>
        <s-link href="/app/tickets">Tickets</s-link>
        <s-link href="/app/repair_services">Repair services</s-link>
        <s-link href="/app/items">Items</s-link>
        {partsEnabled ? <s-link href="/app/parts">Workshop inventory</s-link> : null}
        {tradeInEnabled ? <s-link href="/app/trade_ins">Trade-ins</s-link> : null}
        <s-link href="/app/care_plans">Care plans</s-link>
        <s-link href="/app/warranty_policies">Warranty</s-link>
        <s-link href="/app/product_groups">Product groups</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <FlashToast />
      <SubmitOnEnter />
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
