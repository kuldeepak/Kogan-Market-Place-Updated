import { useEffect } from "react";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings, hasKoganCredentials } from "../kogan/store.server";
import { syncKoganOrders } from "../kogan/orders.server";
import {
  OrderStatusBadge,
  adminOrderUrl,
  formatDateTime,
  formatRelative,
} from "../components/sync-ui";

const PAGE_SIZE = 25;
const FILTERS = {
  all: { label: "All", statuses: null },
  open: { label: "Awaiting dispatch", statuses: ["imported", "partially_dispatched"] },
  dispatched: { label: "Dispatched", statuses: ["dispatched"] },
  cancelled: { label: "Cancelled", statuses: ["cancelled"] },
  error: { label: "Errors", statuses: ["error", "creating"] },
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const filter = FILTERS[url.searchParams.get("status")] ? url.searchParams.get("status") : "all";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const where = { shop };
  if (FILTERS[filter].statuses) where.status = { in: FILTERS[filter].statuses };

  const [settings, total, orders] = await Promise.all([
    getSettings(shop),
    prisma.koganOrder.count({ where }),
    prisma.koganOrder.findMany({
      where,
      orderBy: { orderDate: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  return {
    configured: hasKoganCredentials(settings),
    orderSyncEnabled: settings.orderSyncEnabled,
    orderSyncMinutes: settings.orderSyncMinutes,
    lastOrderSyncAt: settings.lastOrderSyncAt,
    lastOrderSyncError: settings.lastOrderSyncError,
    filter,
    page,
    total,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    orders: orders.map((order) => {
      const items = JSON.parse(order.items || "[]");
      return {
        id: order.id,
        koganOrderId: order.koganOrderId,
        orderLabel: order.orderLabel,
        orderDate: order.orderDate,
        customerName: order.customerName,
        quantity: items.reduce((sum, item) => sum + item.quantity, 0),
        skus: items.map((item) => item.sku).join(", "),
        total: `${order.totalPrice} ${order.currency}`,
        shopifyOrderId: order.shopifyOrderId,
        shopifyName: order.shopifyName,
        status: order.status,
        error: order.error,
      };
    }),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  try {
    const result = await syncKoganOrders(session.shop);
    if (result.alreadyRunning) {
      return { ok: true, message: "Orders are already being fetched" };
    }
    const parts = [`${result.imported} new order${result.imported === 1 ? "" : "s"}`];
    if (result.cancelled) parts.push(`${result.cancelled} cancelled`);
    if (result.failed) parts.push(`${result.failed} failed`);
    return { ok: result.failed === 0, message: parts.join(" · ") };
  } catch (error) {
    return { ok: false, message: "Kogan orders could not be loaded" };
  }
};

function warehouseHint(message) {
  return /warehouse/i.test(message || "")
    ? " Your Kogan seller account does not have a warehouse set up for the Orders API yet. Ask Kogan Marketplace support (marketplace-support@kogan.com.au) to configure it."
    : "";
}

export default function Orders() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const go = (changes) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (!value || value === "all") params.delete(key);
      else params.set(key, String(value));
    }
    if (!("page" in changes)) params.delete("page");
    navigate(`?${params.toString()}`, { preventScrollReset: true });
  };

  return (
    <s-page heading="Kogan orders" inlineSize="large">
      <s-button
        slot="primary-action"
        variant="primary"
        icon="refresh"
        disabled={!data.configured || undefined}
        loading={fetcher.state !== "idle" || undefined}
        onClick={() => fetcher.submit({}, { method: "post" })}
      >
        Fetch orders now
      </s-button>

      <s-stack gap="base">
        {data.lastOrderSyncError ? (
          <s-banner tone="critical" heading="Kogan orders could not be loaded">
            {data.lastOrderSyncError}
            {warehouseHint(data.lastOrderSyncError)}
          </s-banner>
        ) : (
          <s-banner tone="info">
            {data.orderSyncEnabled
              ? `New Kogan orders are fetched automatically every ${data.orderSyncMinutes} minutes.`
              : "Automatic order fetching is turned off in Settings."}{" "}
            Last checked: {formatRelative(data.lastOrderSyncAt).toLowerCase()}.
          </s-banner>
        )}

        <s-section padding="none">
          <s-table>
            <s-stack slot="filters" direction="inline" gap="small-200">
              {Object.entries(FILTERS).map(([key, item]) => (
                <s-button
                  key={key}
                  variant={data.filter === key ? "secondary" : "tertiary"}
                  onClick={() => go({ status: key })}
                >
                  {item.label}
                </s-button>
              ))}
            </s-stack>
            <s-table-header-row>
              <s-table-header listSlot="primary">Kogan order</s-table-header>
              <s-table-header>Date</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Items</s-table-header>
              <s-table-header format="currency">Total</s-table-header>
              <s-table-header>Shopify order</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.orders.map((order) => (
                <s-table-row key={order.id}>
                  <s-table-cell>
                    <s-stack gap="small-300">
                      <s-text type="strong">{order.orderLabel || order.koganOrderId}</s-text>
                      <s-text color="subdued">ID {order.koganOrderId}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{formatDateTime(order.orderDate)}</s-table-cell>
                  <s-table-cell>{order.customerName || "—"}</s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-300">
                      <s-text>{order.quantity} unit{order.quantity === 1 ? "" : "s"}</s-text>
                      <s-text color="subdued">{order.skus}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{order.total}</s-table-cell>
                  <s-table-cell>
                    {order.shopifyOrderId ? (
                      <s-link href={adminOrderUrl(order.shopifyOrderId)}>{order.shopifyName}</s-link>
                    ) : (
                      "—"
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-300">
                      <OrderStatusBadge status={order.status} />
                      {order.error && <s-text tone="critical">{order.error.slice(0, 160)}</s-text>}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>

          {data.orders.length === 0 && (
            <s-box padding="base">
              <s-text color="subdued">
                {data.filter === "all"
                  ? "No Kogan orders yet. When a customer buys one of your products on Kogan, the order appears here and in Shopify Orders."
                  : "No orders match this filter."}
              </s-text>
            </s-box>
          )}

          <s-box padding="base">
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-text color="subdued">
                {data.total} order{data.total === 1 ? "" : "s"} · page {data.page} of {data.pageCount}
              </s-text>
              {data.pageCount > 1 && (
                <s-stack direction="inline" gap="small-200">
                  <s-button
                    icon="chevron-left"
                    accessibilityLabel="Previous page"
                    disabled={data.page <= 1 || undefined}
                    onClick={() => go({ page: data.page - 1 })}
                  />
                  <s-button
                    icon="chevron-right"
                    accessibilityLabel="Next page"
                    disabled={data.page >= data.pageCount || undefined}
                    onClick={() => go({ page: data.page + 1 })}
                  />
                </s-stack>
              )}
            </s-stack>
          </s-box>
        </s-section>
      </s-stack>

      <s-section slot="aside" heading="How order sync works">
        <s-ordered-list>
          <s-list-item>
            A customer buys your product on Kogan. The app fetches the order and creates it in
            Shopify Orders, tagged “Kogan order” and marked as paid.
          </s-list-item>
          <s-list-item>
            Stock is deducted in Shopify, and the new stock level is sent back to Kogan.
          </s-list-item>
          <s-list-item>
            Fulfil the order in Shopify with a tracking number. The app tells Kogan it was
            dispatched, with the tracking details.
          </s-list-item>
          <s-list-item>
            Cancel it in Shopify and it is cancelled on Kogan (Kogan refunds the customer). If the
            customer cancels on Kogan, the Shopify order is cancelled and restocked.
          </s-list-item>
        </s-ordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
