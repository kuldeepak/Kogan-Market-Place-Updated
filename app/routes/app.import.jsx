import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData, useNavigate, useNavigation, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { createKoganClient } from "../kogan/kogan-client.server";
import { pickOffer, variantGroupOf } from "../kogan/mapping.server";
import { getSettings, hasKoganCredentials } from "../kogan/store.server";
import {
  findExistingSkus,
  getLatestJob,
  importSkus,
  startImportJob,
} from "../kogan/sync.server";
import {
  ImportStatusBadge,
  JobBanner,
  adminProductUrl,
  useJobPolling,
} from "../components/sync-ui";

const PAGE_SIZE = 10;

function parseHistory(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || null;
  const history = parseHistory(url.searchParams.get("history"));
  const query = (url.searchParams.get("q") || "").trim();
  const searchBy = url.searchParams.get("by") === "sku" ? "sku" : "title";

  const settings = await getSettings(shop);
  const latestJob = await getLatestJob(shop);
  const base = { cursor, history, query, searchBy, latestJob, page: history.length + 1 };

  if (!hasKoganCredentials(settings)) {
    return { ...base, rows: [], nextCursor: null, error: "Add your Kogan credentials in Settings first." };
  }

  try {
    const kogan = createKoganClient(settings);
    const { results, nextCursor } = await kogan.getProductPage({
      cursor,
      size: PAGE_SIZE,
      search: searchBy === "title" ? query : undefined,
      sku: searchBy === "sku" ? query : undefined,
    });

    const skus = results.map((item) => item.product_sku?.trim()).filter(Boolean);
    const existing = skus.length > 0 ? await findExistingSkus(admin, shop, skus) : new Map();

    const rows = results.map((item) => {
      const sku = item.product_sku?.trim() || "";
      const { currency, offer } = pickOffer(item, settings.currency);
      const match = existing.get(sku);
      const group = variantGroupOf(item);

      return {
        sku,
        title: item.product_title || sku,
        image: item.images?.[0] || null,
        category: item.category || "",
        brand: item.brand || "",
        price: offer.price ? `${Number(offer.price).toFixed(2)} ${currency}` : null,
        stock: item.stock ?? null,
        listed: Boolean(offer.price),
        enabledOnKogan: item.enabled !== false,
        koganUrl: item.store_urls?.[0]?.url || null,
        variantLabel: group
          ? `Variant of ${group.groupTitle || "a product"} · ${group.options
              .map((option) => `${option.name}: ${option.value}`)
              .join(" · ")}`
          : null,
        status: match ? "exists" : "new",
        productId: match?.productId || null,
      };
    });

    return { ...base, rows, nextCursor, error: null };
  } catch (error) {
    return { ...base, rows: [], nextCursor: null, error: error.message };
  }
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "import-all") {
    const job = await startImportJob(session.shop);
    return { intent, jobId: job.id };
  }

  let skus = [];
  try {
    skus = JSON.parse(String(formData.get("skus") || "[]")).map(String).slice(0, 50);
  } catch {
    skus = [];
  }

  if (skus.length === 0) {
    return { intent, results: [], error: "No products were selected." };
  }

  try {
    const results = await importSkus(admin, session.shop, skus, {
      updateExisting: intent === "update",
    });
    return { intent, results, error: null };
  } catch (error) {
    return { intent, results: [], error: error.message };
  }
};

function summarise(results) {
  const count = (status) => results.filter((item) => item.status === status).length;
  return {
    imported: count("imported"),
    updated: count("updated"),
    exists: count("exists"),
    failed: count("failed"),
  };
}

export default function ImportProducts() {
  const { rows, nextCursor, history, cursor, page, query, searchBy, error, latestJob } =
    useLoaderData();
  const fetcher = useFetcher();
  const jobFetcher = useFetcher();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const shopify = useAppBridge();
  const [results, setResults] = useState({});
  const [lastSummary, setLastSummary] = useState(null);

  useJobPolling(latestJob);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
      return;
    }

    const list = fetcher.data.results || [];
    setResults((current) => {
      const next = { ...current };
      for (const item of list) next[item.sku] = item;
      return next;
    });

    const summary = summarise(list);
    setLastSummary(summary);

    const parts = [];
    if (summary.imported) parts.push(`${summary.imported} imported`);
    if (summary.updated) parts.push(`${summary.updated} updated`);
    if (summary.exists) parts.push(`${summary.exists} already existed`);
    if (summary.failed) parts.push(`${summary.failed} failed`);
    shopify.toast.show(parts.join(" · ") || "Nothing to import", { isError: summary.failed > 0 });
  }, [fetcher.state, fetcher.data, shopify]);

  const busySkus = useMemo(() => {
    if (fetcher.state === "idle" || !fetcher.formData) return new Set();
    try {
      return new Set(JSON.parse(String(fetcher.formData.get("skus") || "[]")));
    } catch {
      return new Set();
    }
  }, [fetcher.state, fetcher.formData]);

  const viewRows = rows.map((row) => {
    const result = results[row.sku];
    return result
      ? { ...row, status: result.status, productId: result.productId || row.productId, message: result.message }
      : row;
  });

  const newSkus = viewRows.filter((row) => row.status === "new" || row.status === "failed").map((row) => row.sku);
  const pageCounts = {
    imported: viewRows.filter((row) => row.status === "imported").length,
    exists: viewRows.filter((row) => row.status === "exists").length,
    pending: newSkus.length,
  };

  const loadingPage = navigation.state === "loading";
  const jobRunning = latestJob?.status === "running";

  const go = (changes) => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === undefined || value === "") params.delete(key);
      else params.set(key, String(value));
    }
    setLastSummary(null);
    navigate(`?${params.toString()}`, { preventScrollReset: true });
  };

  const goNext = () =>
    go({ cursor: nextCursor, history: JSON.stringify([...history, cursor || ""]) });

  const goPrevious = () => {
    const previous = history.slice(0, -1);
    go({
      cursor: history[history.length - 1] || null,
      history: previous.length > 0 ? JSON.stringify(previous) : null,
    });
  };

  const search = (value, by = searchBy) =>
    go({ q: value.trim() || null, by: by === "sku" ? "sku" : null, cursor: null, history: null });

  const submitSkus = (skus, intent = "import") =>
    fetcher.submit({ intent, skus: JSON.stringify(skus) }, { method: "post" });

  return (
    <s-page heading="Import from Kogan" inlineSize="large">
      <s-button
        slot="primary-action"
        variant="primary"
        commandFor="import-all-modal"
        command="--show"
        disabled={jobRunning || Boolean(error) || undefined}
      >
        Import all products
      </s-button>

      <s-modal id="import-all-modal" heading="Import your whole Kogan catalogue?">
        <s-stack gap="base">
          <s-paragraph>
            Every Kogan product is checked in the background, 100 at a time. Products whose SKU
            already exists in Shopify are skipped and marked as “Already exists”, so nothing is
            duplicated.
          </s-paragraph>
          <s-paragraph>
            Large catalogues can take a while. You can close this page; progress is shown on the
            dashboard and here.
          </s-paragraph>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="import-all-modal"
          command="--hide"
          onClick={() => jobFetcher.submit({ intent: "import-all" }, { method: "post" })}
        >
          Start import
        </s-button>
        <s-button slot="secondary-actions" commandFor="import-all-modal" command="--hide">
          Cancel
        </s-button>
      </s-modal>

      <s-stack gap="base">
        <JobBanner job={latestJob} />

        {error && (
          <s-banner tone="critical" heading="Kogan products could not be loaded">
            {error}
          </s-banner>
        )}

        {lastSummary && (
          <s-banner
            tone={lastSummary.failed > 0 ? "warning" : "success"}
            heading="Import finished for the selected products"
          >
            {lastSummary.imported} imported · {lastSummary.updated} updated ·{" "}
            {lastSummary.exists} already existed · {lastSummary.failed} failed
          </s-banner>
        )}

        <s-section padding="none">
          <s-table loading={loadingPage || undefined}>
            <s-stack slot="filters" gap="small">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-search-field
                  key={`${searchBy}-${query}`}
                  label="Search Kogan products"
                  labelAccessibilityVisibility="exclusive"
                  placeholder={searchBy === "sku" ? "Exact SKU, e.g. TEST-KOGAN-001" : "Search product titles"}
                  value={query}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") search(event.currentTarget.value);
                  }}
                />
                <s-stack direction="inline" gap="small-200">
                  <s-button
                    variant={searchBy === "title" ? "secondary" : "tertiary"}
                    onClick={() => search(query, "title")}
                  >
                    Title
                  </s-button>
                  <s-button
                    variant={searchBy === "sku" ? "secondary" : "tertiary"}
                    onClick={() => search(query, "sku")}
                  >
                    SKU
                  </s-button>
                </s-stack>
              </s-stack>
              <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
                <s-stack direction="inline" gap="small-200">
                  <s-badge tone="success">{pageCounts.imported} imported</s-badge>
                  <s-badge tone="warning">{pageCounts.exists} already exist</s-badge>
                  <s-badge tone="neutral">{pageCounts.pending} not imported</s-badge>
                </s-stack>
                <s-button
                  icon="import"
                  disabled={newSkus.length === 0 || fetcher.state !== "idle" || undefined}
                  loading={(fetcher.state !== "idle" && busySkus.size > 1) || undefined}
                  onClick={() => submitSkus(newSkus)}
                >
                  {newSkus.length > 0
                    ? `Import this page (${newSkus.length})`
                    : "Everything on this page is imported"}
                </s-button>
              </s-stack>
            </s-stack>

            <s-table-header-row>
              <s-table-header listSlot="primary">Kogan product</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header format="currency">Kogan price</s-table-header>
              <s-table-header format="numeric">Kogan stock</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>

            <s-table-body>
              {viewRows.map((row) => {
                const busy = busySkus.has(row.sku);
                const inShopify = row.status === "exists" || row.status === "imported" || row.status === "updated";

                return (
                  <s-table-row key={row.sku || row.title}>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small" alignItems="center">
                        <s-thumbnail src={row.image || undefined} alt={row.title} size="small" />
                        <s-stack gap="small-300">
                          <s-text type="strong">{row.title}</s-text>
                          <s-text color="subdued">
                            {[row.brand, row.category].filter(Boolean).join(" · ") || "—"}
                          </s-text>
                          {row.variantLabel && <s-text color="subdued">{row.variantLabel}</s-text>}
                        </s-stack>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{row.sku || "—"}</s-table-cell>
                    <s-table-cell>{row.price || "—"}</s-table-cell>
                    <s-table-cell>{row.stock ?? "—"}</s-table-cell>
                    <s-table-cell>
                      <s-stack gap="small-300">
                        <s-stack direction="inline" gap="small-200">
                          <ImportStatusBadge status={row.status} />
                          {!row.listed && <s-badge tone="neutral">Not listed on Kogan</s-badge>}
                        </s-stack>
                        {row.status === "failed" && row.message && (
                          <s-text tone="critical">{row.message.slice(0, 160)}</s-text>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-200">
                        {!inShopify && (
                          <s-button
                            variant="secondary"
                            loading={busy || undefined}
                            disabled={!row.sku || (fetcher.state !== "idle" && !busy) || undefined}
                            onClick={() => submitSkus([row.sku])}
                          >
                            Import
                          </s-button>
                        )}
                        {inShopify && row.productId && (
                          <s-button variant="tertiary" href={adminProductUrl(row.productId)}>
                            View in Shopify
                          </s-button>
                        )}
                        {row.status === "exists" && (
                          <s-button
                            variant="tertiary"
                            loading={busy || undefined}
                            disabled={(fetcher.state !== "idle" && !busy) || undefined}
                            onClick={() => submitSkus([row.sku], "update")}
                          >
                            Update from Kogan
                          </s-button>
                        )}
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>

          {rows.length === 0 && !error && (
            <s-box padding="base">
              <s-text color="subdued">
                {query ? `No Kogan products match “${query}”.` : "No products found in your Kogan account."}
              </s-text>
            </s-box>
          )}

          <s-box padding="base">
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-text color="subdued">
                Page {page} · {PAGE_SIZE} products per page
              </s-text>
              <s-stack direction="inline" gap="small-200">
                <s-button
                  icon="chevron-left"
                  accessibilityLabel="Previous page"
                  disabled={page <= 1 || loadingPage || undefined}
                  onClick={goPrevious}
                />
                <s-button
                  icon="chevron-right"
                  accessibilityLabel="Next page"
                  disabled={!nextCursor || loadingPage || undefined}
                  onClick={goNext}
                />
              </s-stack>
            </s-stack>
          </s-box>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
