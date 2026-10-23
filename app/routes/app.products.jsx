import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings } from "../kogan/store.server";
import { pushProductToKogan } from "../kogan/sync.server";
import { setProductKoganCategory, shopifyGraphql } from "../kogan/shopify-products.server";
import {
  categorySourceFor,
  presentCategory,
  resolveCategoryValue,
  resolveCategoryValues,
} from "../kogan/categories.server";
import { CategoryPicker } from "../components/category-picker";
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

  const settings = await getSettings(shop);
  const { source } = categorySourceFor(settings);
  const categoryFilter = (url.searchParams.get("category") || "").trim();
  let categoryWhere = {};
  let activeCategory = null;

  if (categoryFilter === "none") {
    categoryWhere = { koganCategory: null };
    activeCategory = { title: "No category of their own", display: "Uses the default category" };
  } else if (/^\d+$/.test(categoryFilter)) {
    // A category can be stored as "kogan:ID", a name or a slug, so every
    // stored value that points at this category is matched.
    const values = (
      await prisma.koganProductLink.groupBy({
        by: ["koganCategory"],
        where: { shop, koganCategory: { not: null } },
      })
    ).map((row) => row.koganCategory);
    const resolved = await resolveCategoryValues(source, values);
    const matching = values.filter((value) => resolved.get(value)?.id === Number(categoryFilter));
    categoryWhere = { koganCategory: { in: matching } };
    const record = await resolveCategoryValue(source, `kogan:${categoryFilter}`);
    activeCategory = { title: record?.title || `kogan:${categoryFilter}`, display: record?.display || "" };
  } else if (categoryFilter) {
    categoryWhere = { koganCategory: categoryFilter };
    activeCategory = { title: categoryFilter, display: "Not recognised by Kogan" };
  }

  const where = {
    shop,
    ...(status !== "all" ? { syncStatus: status } : {}),
    ...(query ? { koganSku: { contains: query } } : {}),
    ...categoryWhere,
  };

  const [total, links, counts] = await Promise.all([
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

  const categoryRecords = await resolveCategoryValues(
    source,
    [...links.map((link) => link.koganCategory), settings.defaultCategory].filter(Boolean),
  );
  const defaultCategory = settings.defaultCategory
    ? presentCategory(categoryRecords.get(settings.defaultCategory))
    : null;

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
      taskId: link.lastTaskId,
      lastSyncedAt: link.lastSyncedAt,
      koganUrl: link.koganStoreUrl,
      categoryValue: link.koganCategory,
      category: link.koganCategory
        ? presentCategory(categoryRecords.get(link.koganCategory)) || {
            unknown: true,
            title: link.koganCategory,
          }
        : null,
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
    currency: settings.currency,
    defaultCategory,
    activeCategory,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = String(formData.get("productId") || "");

  if (!productId.startsWith("gid://shopify/Product/")) {
    return { ok: false, message: "Unknown product." };
  }

  if (formData.get("intent") === "set-category") {
    const value = String(formData.get("value") || "").trim();
    if (value && !/^kogan:\d+$/.test(value)) {
      return { ok: false, message: "Choose a category from the list." };
    }

    try {
      await setProductKoganCategory(admin, [productId], value || null);
      const result = await pushProductToKogan(admin, session.shop, productId, { reason: "manual" });
      if (result.failed > 0) {
        return { ok: false, message: "Category saved in Shopify, but Kogan rejected it. See the error on the product row." };
      }
      return {
        ok: true,
        message: value ? "Category saved and sent to Kogan" : "Category removed; the default category will be used",
      };
    } catch (error) {
      return { ok: false, message: error.message };
    }
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

function CategoryCell({ category, defaultCategory, onChange }) {
  return (
    <s-stack gap="small-300">
      {category?.unknown ? (
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-badge tone="critical">Not recognised</s-badge>
          <s-text>{category.title}</s-text>
        </s-stack>
      ) : category ? (
        <>
          <s-text type="strong">{category.title}</s-text>
          <s-text color="subdued">{category.path.slice(0, -1).join(" › ")}</s-text>
        </>
      ) : (
        <>
          <s-text color="subdued">Default category</s-text>
          <s-text color="subdued">{defaultCategory ? defaultCategory.title : "No default set"}</s-text>
        </>
      )}
      <s-stack direction="inline">
        <s-button variant="tertiary" commandFor="category-modal" command="--show" onClick={onChange}>
          Change
        </s-button>
      </s-stack>
    </s-stack>
  );
}

export default function Products() {
  const {
    rows,
    total,
    page,
    pageCount,
    query,
    status,
    syncTag,
    countByStatus,
    currency,
    defaultCategory,
    activeCategory,
  } = useLoaderData();
  const categoryFetcher = useFetcher();
  const shopify = useAppBridge();
  const modalRef = useRef(null);
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    if (categoryFetcher.state === "idle" && categoryFetcher.data?.message) {
      shopify.toast.show(categoryFetcher.data.message, { isError: !categoryFetcher.data.ok });
    }
  }, [categoryFetcher.state, categoryFetcher.data, shopify]);

  const saveCategory = (value) => {
    if (!editing) return;
    categoryFetcher.submit(
      { intent: "set-category", productId: editing.productId, value },
      { method: "post" },
    );
    modalRef.current?.hideOverlay?.();
  };
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
    pending: `Awaiting Kogan (${countByStatus.pending || 0})`,
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
            <s-button slot="primary-action" variant="primary" href="/app/">
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
              {activeCategory && (
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-badge tone="info">Category: {activeCategory.title}</s-badge>
                  <s-button variant="tertiary" icon="x" accessibilityLabel="Clear category filter" onClick={() => go({ category: null })} />
                </s-stack>
              )}
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
              <s-table-header>Kogan category</s-table-header>
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
                    <CategoryCell
                      category={row.category}
                      defaultCategory={defaultCategory}
                      onChange={() => setEditing(row)}
                    />
                  </s-table-cell>
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
                        <s-text tone="critical">{row.syncError.split(" Last Kogan task ID:")[0].slice(0, 220)}</s-text>
                      )}
                      {row.syncStatus === "pending" && (
                        <s-text color="subdued">Sent; the app confirms it on Kogan in about 10 minutes.</s-text>
                      )}
                      {row.taskId && (row.syncStatus === "error" || row.syncStatus === "pending") && (
                        <s-text color="subdued">Kogan task ID: {row.taskId}</s-text>
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

      <s-modal
        id="category-modal"
        ref={modalRef}
        heading={editing ? `Kogan category · ${editing.title}` : "Kogan category"}
      >
        <s-stack gap="base">
          <s-paragraph>
            Current:{" "}
            <s-text type="strong">
              {editing?.category?.unknown
                ? `${editing.category.title} (not recognised by Kogan)`
                : editing?.category
                  ? editing.category.display
                  : `Default category${defaultCategory ? ` (${defaultCategory.title})` : ""}`}
            </s-text>
          </s-paragraph>
          <s-text color="subdued">
            The category applies to every variant of this product and is sent to Kogan as soon as
            you choose it.
          </s-text>
          <CategoryPicker
            key={editing?.id || "none"}
            currency={currency}
            actionLabel="Choose"
            selectedValue={editing?.category?.value || null}
            onSelect={(value) => saveCategory(value)}
          />
        </s-stack>
        {editing?.categoryValue && (
          <s-button slot="secondary-actions" onClick={() => saveCategory("")}>
            Use default category
          </s-button>
        )}
        <s-button slot="secondary-actions" commandFor="category-modal" command="--hide">
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
