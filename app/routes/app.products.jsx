import { useEffect } from "react";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings } from "../kogan/store.server";
import { pushProductToKogan } from "../kogan/sync.server";
import { shopifyGraphql } from "../kogan/shopify-products.server";
import {
  ProductStatusBadge,
  SyncStatusBadge,
  adminProductUrl,
  formatRelative,
} from "../components/sync-ui";

const PAGE_SIZE = 25;

function parseSnapshot(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}
const STATUS_FILTERS = ["all", "synced", "pending", "error"];

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const status = STATUS_FILTERS.includes(url.searchParams.get("status"))
    ? url.searchParams.get("status")
    : "all";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const where = {
    shop,
    ...(status !== "all" ? { syncStatus: status } : {}),
    ...(query ? { koganSku: { contains: query } } : {}),
  };

  const [settings, total, links, counts] = await Promise.all([
    getSettings(shop),
    prisma.koganProductLink.count({ where }),
    prisma.koganProductLink.findMany({
      where,
      orderBy: [{ syncStatus: "asc" }, { updatedAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.koganProductLink.groupBy({
      by: ["syncStatus"],
      where: { shop },
      _count: { _all: true },
    }),
  ]);

  const productIds = [...new Set(links.map((link) => link.shopifyProductId))];
  const products = new Map();

  if (productIds.length > 0) {
    const data = await shopifyGraphql(
      admin,
      `#graphql
        query LinkedProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              title
              status
              featuredMedia {
                preview {
                  image {
                    url(transform: { maxWidth: 80, maxHeight: 80 })
                  }
                }
              }
              variants(first: 100) {
                nodes {
                  id
                  title
                  sku
                  price
                  inventoryQuantity
                  image {
                    url(transform: { maxWidth: 80, maxHeight: 80 })
                  }
                }
              }
            }
          }
        }
      `,
      { ids: productIds },
    );

    for (const node of data.nodes) {
      if (node) products.set(node.id, node);
    }
  }

  const rows = links.map((link) => {
    const product = products.get(link.shopifyProductId);
    const variant =
      product?.variants.nodes.find((item) => item.id === link.shopifyVariantId) ||
      product?.variants.nodes.find((item) => item.sku === link.koganSku);

    return {
      id: link.id,
      sku: link.koganSku,
      productId: link.shopifyProductId,
      title: product?.title || "Product not found in Shopify",
      variantTitle: variant && variant.title !== "Default Title" ? variant.title : null,
      image: variant?.image?.url || product?.featuredMedia?.preview?.image?.url || null,
      productStatus: product?.status || null,
      price: variant?.price ?? null,
      koganPrice: typeof parseSnapshot(link.snapshot)?.price === "string"
        ? parseSnapshot(link.snapshot).price
        : null,
      stock: variant?.inventoryQuantity ?? null,
      currency: link.currency,
      syncStatus: link.syncStatus,
      syncError: link.syncError,
      lastSyncedAt: link.lastSyncedAt,
      koganUrl: link.koganStoreUrl,
    };
  });

  const countByStatus = Object.fromEntries(
    counts.map((item) => [item.syncStatus, item._count._all]),
  );

  return {
    rows,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    query,
    status,
    syncTag: settings.syncTag,
    countByStatus,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = String(formData.get("productId") || "");

  if (!productId.startsWith("gid://shopify/Product/")) {
    return { ok: false, message: "Unknown product." };
  }

  try {
    const result = await pushProductToKogan(admin, session.shop, productId, { reason: "manual" });

    if (result.failed > 0) {
      return { ok: false, message: "Kogan rejected the update. See the error on the product row." };
    }
    if (result.skipped > 0 && result.created + result.updated + result.unchanged === 0) {
      return { ok: false, message: "This product is not tagged for Kogan sync or has no SKU." };
    }
    return {
      ok: true,
      message: result.created + result.updated > 0 ? "Sent to Kogan" : "Already up to date on Kogan",
    };
  } catch (error) {
    return { ok: false, message: error.message };
  }
};

function SyncButton({ productId }) {
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <s-button
      variant="tertiary"
      icon="refresh"
      loading={fetcher.state !== "idle" || undefined}
      onClick={() => fetcher.submit({ productId }, { method: "post" })}
    >
      Sync now
    </s-button>
  );
}

export default function Products() {
  const { rows, total, page, pageCount, query, status, syncTag, countByStatus } =
    useLoaderData();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const go = (changes) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "" || value === "all") params.delete(key);
      else params.set(key, String(value));
    }
    if (!("page" in changes)) params.delete("page");
    navigate(`?${params.toString()}`, { preventScrollReset: true });
  };

  const allCount = Object.values(countByStatus).reduce((sum, value) => sum + value, 0);
  const filterLabel = {
    all: `All (${allCount})`,
    synced: `Synced (${countByStatus.synced || 0})`,
    pending: `Pending (${countByStatus.pending || 0})`,
    error: `Errors (${countByStatus.error || 0})`,
  };

  return (
    <s-page heading="Kogan products" inlineSize="large">
      <s-button slot="secondary-actions" href={`shopify://admin/products?tag=${encodeURIComponent(syncTag)}`}>
        Open in Shopify products
      </s-button>

      {allCount === 0 ? (
        <s-section>
          <s-empty-state heading="No Kogan products yet">
            <s-paragraph slot="subheading">
              Import your Kogan catalogue from the dashboard, or add the “{syncTag}” tag to a
              Shopify product to list it on Kogan.
            </s-paragraph>
            <s-button slot="primary-action" variant="primary" href="/app">
              Go to dashboard
            </s-button>
          </s-empty-state>
        </s-section>
      ) : (
        <s-section padding="none">
          <s-table>
            <s-stack slot="filters" direction="inline" gap="small" alignItems="center">
              <s-search-field
                key={query}
                label="Search by SKU"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by SKU"
                value={query}
                onKeyDown={(event) => {
                  if (event.key === "Enter") go({ q: event.currentTarget.value.trim() });
                }}
                onBlur={(event) => {
                  const value = event.currentTarget.value.trim();
                  if (value !== query) go({ q: value });
                }}
              />
              <s-stack direction="inline" gap="small-200">
                {STATUS_FILTERS.map((item) => (
                  <s-button
                    key={item}
                    variant={status === item ? "secondary" : "tertiary"}
                    onClick={() => go({ status: item })}
                  >
                    {filterLabel[item]}
                  </s-button>
                ))}
              </s-stack>
            </s-stack>

            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header format="currency">Shopify price</s-table-header>
              <s-table-header format="currency">Kogan price</s-table-header>
              <s-table-header format="numeric">Stock</s-table-header>
              <s-table-header>Shopify status</s-table-header>
              <s-table-header listSlot="secondary">Kogan sync</s-table-header>
              <s-table-header>Last synced</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>

            <s-table-body>
              {rows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-thumbnail src={row.image || undefined} alt={row.title} size="small" />
                      <s-stack gap="small-300">
                        <s-link href={adminProductUrl(row.productId)}>{row.title}</s-link>
                        {row.variantTitle && <s-text color="subdued">Variant: {row.variantTitle}</s-text>}
                      </s-stack>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{row.sku}</s-table-cell>
                  <s-table-cell>
                    {row.price ?? "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {row.koganPrice ? `${row.koganPrice} ${row.currency}` : "—"}
                  </s-table-cell>
                  <s-table-cell>{row.stock ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <ProductStatusBadge status={row.productStatus} />
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-300">
                      <SyncStatusBadge status={row.syncStatus} />
                      {row.syncError && (
                        <s-text tone="critical">{row.syncError.slice(0, 160)}</s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{formatRelative(row.lastSyncedAt)}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      {row.productStatus && <SyncButton productId={row.productId} />}
                      {row.koganUrl && (
                        <s-button variant="tertiary" href={row.koganUrl} target="_blank">
                          View on Kogan
                        </s-button>
                      )}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>

          {rows.length === 0 && (
            <s-box padding="base">
              <s-text color="subdued">No products match these filters.</s-text>
            </s-box>
          )}
          <s-box padding="base">
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-text color="subdued">
                {total} product{total === 1 ? "" : "s"} · page {page} of {pageCount}
              </s-text>
              {pageCount > 1 && (
                <s-stack direction="inline" gap="small-200">
                  <s-button
                    icon="chevron-left"
                    accessibilityLabel="Previous page"
                    disabled={page <= 1 || undefined}
                    onClick={() => go({ page: page - 1 })}
                  />
                  <s-button
                    icon="chevron-right"
                    accessibilityLabel="Next page"
                    disabled={page >= pageCount || undefined}
                    onClick={() => go({ page: page + 1 })}
                  />
                </s-stack>
              )}
            </s-stack>
          </s-box>
        </s-section>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
