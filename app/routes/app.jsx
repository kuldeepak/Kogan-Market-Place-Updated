import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { ensureVariantKoganPriceDefinition } from "../kogan/shopify-products.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  await ensureVariantKoganPriceDefinition(admin, session.shop).catch((error) =>
    console.error("Unable to create the variant Kogan price metafield definition:", error.message),
  );

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/import">Import</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href="/app/orders">Orders</s-link>
        <s-link href="/app/activity">Activity</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
