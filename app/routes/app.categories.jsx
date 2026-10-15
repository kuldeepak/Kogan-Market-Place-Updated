import { useEffect } from "react";
import { useFetcher, useLoaderData, useNavigate, useNavigation, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  categoryUsage,
  ensureCategories,
  isRefreshingCategories,
  presentCategory,
  refreshCategories,
  resolveCategoryValue,
  searchCategories,
} from "../kogan/categories.server";
import { getSettings, saveSettings } from "../kogan/store.server";
import { formatRelative } from "../components/sync-ui";

const PAGE_SIZE = 25;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const settings = await getSettings(shop);
  const { source, sync } = await ensureCategories(settings);
  const usage = await categoryUsage(shop, source);
  const usedIds = [...usage.byCategory.keys()];

  const requestedView = url.searchParams.get("view");
  const view = requestedView === "all" || requestedView === "used" ? requestedView : usedIds.length > 0 ? "used" : "all";

  let total = 0;
  let items = [];
  if (sync?.count > 0 && (view === "all" || usedIds.length > 0)) {
    const result = await searchCategories(source, {
      query,
      ids: view === "used" ? usedIds : null,
      page,
      pageSize: PAGE_SIZE,
    });
    total = result.total;
    items = result.items;
  }

  const defaultCategory = settings.defaultCategory
    ? presentCategory(await resolveCategoryValue(source, settings.defaultCategory))
    : null;

  return {
    view,
    query,
    page,
    total,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    store: source.split("|")[1].toUpperCase(),
    sync: {
      status: isRefreshingCategories(source) ? "running" : sync?.status || "never",
      count: sync?.count || 0,
      syncedAt: sync?.syncedAt || null,
      error: sync?.error || null,
    },
    usedCount: usedIds.length,
    withoutCategory: usage.withoutCategory,
    unknown: [...usage.unknown.entries()].map(([value, entry]) => ({
      value,
      products: entry.products,
      skus: entry.skus,
    })),
    defaultCategory,
    defaultValue: settings.defaultCategory || null,
    rows: items.map((item) => {
      const category = presentCategory(item);
      const used = usage.byCategory.get(item.id);
      return {
        ...category,
        products: used?.products || 0,
        skus: used?.skus || 0,
        isDefault: defaultCategory?.id === item.id,
      };
    }),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const settings = await getSettings(session.shop);

  if (intent === "refresh") {
    refreshCategories(settings).catch((error) =>
      console.error("Kogan category refresh failed:", error.message),
    );
    return { ok: true, message: "Downloading categories from Kogan…" };
  }

  if (intent === "set-default") {
    const value = String(formData.get("value") || "");
    if (!/^kogan:\d+$/.test(value)) return { ok: false, message: "Unknown category" };
    await saveSettings(session.shop, { defaultCategory: value });
    return { ok: true, message: "Default category saved" };
  }

  return { ok: false, message: "Unknown action" };
};

function StatCard({ label, value, detail }) {
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack gap="small-300">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {detail && <s-text color="subdued">{detail}</s-text>}
      </s-stack>
    </s-box>
  );
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export default function Categories() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams] = useSearchParams();

  const refreshing = data.sync.status === "running";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  useEffect(() => {
    if (!refreshing) return undefined;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [refreshing, revalidator]);

  const go = (changes) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === undefined || value === "") params.delete(key);
      else params.set(key, String(value));
    }
    if (!("page" in changes)) params.delete("page");
    navigate(`?${params.toString()}`, { preventScrollReset: true });
  };

  const busyValue =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "set-default"
      ? fetcher.formData.get("value")
      : null;

  return (
    <s-page heading="Kogan categories" inlineSize="large">
      <s-button
        slot="primary-action"
        icon="refresh"
        loading={refreshing || (fetcher.state !== "idle" && fetcher.formData?.get("intent") === "refresh") || undefined}
        onClick={() => fetcher.submit({ intent: "refresh" }, { method: "post" })}
      >
        Refresh from Kogan
      </s-button>

      <s-stack gap="base">
        {refreshing && (
          <s-banner tone="info" heading="Downloading categories from Kogan">
            This usually takes under a minute. The list updates automatically when it is done.
          </s-banner>
        )}
        {!refreshing && data.sync.status === "error" && (
          <s-banner tone="critical" heading="Kogan categories could not be downloaded">
            {data.sync.error} Try “Refresh from Kogan” again in a few minutes.
          </s-banner>
        )}
        {!refreshing && data.sync.count === 0 && data.sync.status !== "error" && (
          <s-banner tone="info" heading="Categories have not been downloaded yet">
            Click “Refresh from Kogan” to load the full Kogan category list.
          </s-banner>
        )}
        {data.unknown.length > 0 && (
          <s-banner tone="warning" heading="Some products use a category Kogan does not recognise">
            {data.unknown.map((item) => `“${item.value}” (${plural(item.products, "product")})`).join(", ")}.{" "}
            Kogan rejects these, so choose a category for them on the{" "}
            <s-link href={`/app/products?category=${encodeURIComponent(data.unknown[0].value)}`}>Products</s-link> page.
          </s-banner>
        )}

        <s-section heading="Overview">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
            <StatCard
              label={`Kogan categories (${data.store})`}
              value={data.sync.count.toLocaleString()}
              detail={data.sync.syncedAt ? `Updated ${formatRelative(data.sync.syncedAt).toLowerCase()}` : "Not downloaded yet"}
            />
            <StatCard
              label="Categories you use"
              value={data.usedCount}
              detail="Across your linked products"
            />
            <StatCard
              label="Products without a category"
              value={data.withoutCategory.products}
              detail={data.defaultCategory ? `Use the default: ${data.defaultCategory.title}` : "No default category set"}
            />
            <StatCard
              label="Default category"
              value={data.defaultCategory ? data.defaultCategory.title : "Not set"}
              detail={data.defaultCategory ? data.defaultCategory.display : "Used when a product has no category"}
            />
          </s-grid>
        </s-section>

        <s-section padding="none">
          <s-table loading={navigation.state === "loading" || undefined}>
            <s-stack slot="filters" gap="small">
              <s-stack direction="inline" gap="small-200">
                <s-button
                  variant={data.view === "used" ? "secondary" : "tertiary"}
                  onClick={() => go({ view: "used" })}
                >
                  Used by your products ({data.usedCount})
                </s-button>
                <s-button
                  variant={data.view === "all" ? "secondary" : "tertiary"}
                  onClick={() => go({ view: "all" })}
                >
                  All categories ({data.sync.count.toLocaleString()})
                </s-button>
              </s-stack>
              <s-search-field
                key={`${data.view}-${data.query}`}
                label="Search categories"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by name, path or ID, e.g. headphones or 46114"
                value={data.query}
                onKeyDown={(event) => {
                  if (event.key === "Enter") go({ q: event.currentTarget.value.trim() });
                }}
              />
            </s-stack>

            <s-table-header-row>
              <s-table-header listSlot="primary">Category</s-table-header>
              <s-table-header>Department</s-table-header>
              <s-table-header>Kogan ID</s-table-header>
              <s-table-header listSlot="secondary">Your products</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.rows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>
                    <s-stack gap="small-300">
                      <s-stack direction="inline" gap="small-200" alignItems="center">
                        <s-text type="strong">{row.title}</s-text>
                        {row.isDefault && <s-badge tone="info">Default</s-badge>}
                      </s-stack>
                      <s-text color="subdued">{row.path.slice(0, -1).join(" › ") || "Top level"}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{row.departments.join(", ") || "—"}</s-table-cell>
                  <s-table-cell>{row.value}</s-table-cell>
                  <s-table-cell>
                    {row.products > 0 ? (
                      <s-link href={`/app/products?category=${row.id}`}>
                        {plural(row.products, "product")} · {plural(row.skus, "SKU")}
                      </s-link>
                    ) : (
                      <s-text color="subdued">None</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      {!row.isDefault && (
                        <s-button
                          variant="tertiary"
                          loading={busyValue === row.value || undefined}
                          onClick={() => fetcher.submit({ intent: "set-default", value: row.value }, { method: "post" })}
                        >
                          Set as default
                        </s-button>
                      )}
                      {row.url && (
                        <s-button variant="tertiary" href={row.url} target="_blank">
                          View on Kogan
                        </s-button>
                      )}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>

          {data.rows.length === 0 && (
            <s-box padding="base">
              <s-text color="subdued">
                {data.sync.count === 0
                  ? "No categories downloaded yet."
                  : data.query
                    ? `No categories match “${data.query}”.`
                    : data.view === "used"
                      ? "None of your linked products has a Kogan category yet. Set one from the Products page or choose a default category."
                      : "No categories found."}
              </s-text>
            </s-box>
          )}

          <s-box padding="base">
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-text color="subdued">
                {data.total.toLocaleString()} categor{data.total === 1 ? "y" : "ies"} · page {data.page} of {data.pageCount}
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

      <s-section slot="aside" heading="How categories work">
        <s-ordered-list>
          <s-list-item>
            Every product on Kogan needs a category. It is stored in the product’s “Kogan
            category” metafield in Shopify as <s-text type="strong">kogan:ID</s-text>.
          </s-list-item>
          <s-list-item>
            Products imported from Kogan keep their Kogan category automatically.
          </s-list-item>
          <s-list-item>
            Change a product’s category from the Products page. The change is sent to Kogan
            straight away.
          </s-list-item>
          <s-list-item>
            Products without their own category use the default category when they are listed
            on Kogan.
          </s-list-item>
          <s-list-item>
            The category list is downloaded from Kogan and refreshed automatically every week.
          </s-list-item>
        </s-ordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
