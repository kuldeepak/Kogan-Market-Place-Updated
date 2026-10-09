import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  LogStatusBadge,
  actionLabel,
  adminProductUrl,
  directionLabel,
  formatDateTime,
  useActivityDelete,
} from "../components/sync-ui";

const PAGE_SIZE = 50;
const FILTERS = {
  all: "All",
  error: "Errors",
  shopify_to_kogan: "Shopify → Kogan",
  kogan_to_shopify: "Kogan → Shopify",
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = FILTERS[url.searchParams.get("status")] ? url.searchParams.get("status") : "all";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const where = { shop: session.shop };
  if (filter === "error") where.status = "error";
  if (filter === "shopify_to_kogan" || filter === "kogan_to_shopify") where.direction = filter;

  const [total, logs] = await Promise.all([
    prisma.syncLog.count({ where }),
    prisma.syncLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  return { logs, total, page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)), filter };
};

export default function Activity() {
  const { logs, total, page, pageCount, filter } = useLoaderData();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { remove, busy, deletingId } = useActivityDelete();

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
    <s-page heading="Sync activity" inlineSize="large">
      <s-button
        slot="secondary-actions"
        commandFor="delete-old-modal"
        command="--show"
        disabled={total === 0 || busy || undefined}
      >
        Delete older than 30 days
      </s-button>
      <s-button
        slot="secondary-actions"
        tone="critical"
        commandFor="delete-filter-modal"
        command="--show"
        disabled={total === 0 || busy || undefined}
      >
        {filter === "all" ? "Delete all activity" : `Delete all “${FILTERS[filter]}”`}
      </s-button>

      <s-modal id="delete-old-modal" heading="Delete activity older than 30 days?">
        <s-paragraph>
          Entries from the last 30 days are kept. This only removes the activity history; it
          does not change any product or order.
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          commandFor="delete-old-modal"
          command="--hide"
          onClick={() => remove({ intent: "delete-older", days: "30" })}
        >
          Delete
        </s-button>
        <s-button slot="secondary-actions" commandFor="delete-old-modal" command="--hide">
          Cancel
        </s-button>
      </s-modal>

      <s-modal
        id="delete-filter-modal"
        heading={filter === "all" ? "Delete all activity?" : `Delete all “${FILTERS[filter]}” entries?`}
      >
        <s-paragraph>
          {total} entr{total === 1 ? "y" : "ies"} will be deleted permanently. This only removes
          the activity history; it does not change any product or order.
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          commandFor="delete-filter-modal"
          command="--hide"
          onClick={() => remove({ intent: "delete-filter", filter })}
        >
          Delete {total}
        </s-button>
        <s-button slot="secondary-actions" commandFor="delete-filter-modal" command="--hide">
          Cancel
        </s-button>
      </s-modal>

      <s-section padding="none">
        <s-table>
          <s-stack slot="filters" direction="inline" gap="small-200">
            {Object.entries(FILTERS).map(([key, label]) => (
              <s-button
                key={key}
                variant={filter === key ? "secondary" : "tertiary"}
                onClick={() => go({ status: key })}
              >
                {label}
              </s-button>
            ))}
          </s-stack>
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header>SKU</s-table-header>
            <s-table-header>Direction</s-table-header>
            <s-table-header>Action</s-table-header>
            <s-table-header listSlot="secondary">Result</s-table-header>
            <s-table-header>Details</s-table-header>
            <s-table-header>Time</s-table-header>
            <s-table-header>
              <s-text accessibilityVisibility="exclusive">Actions</s-text>
            </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {logs.map((log) => (
              <s-table-row key={log.id}>
                <s-table-cell>
                  {log.productId ? (
                    <s-link href={adminProductUrl(log.productId)}>{log.title || "View product"}</s-link>
                  ) : (
                    log.title || "—"
                  )}
                </s-table-cell>
                <s-table-cell>{log.sku || "—"}</s-table-cell>
                <s-table-cell>{directionLabel(log.direction)}</s-table-cell>
                <s-table-cell>{actionLabel(log.action)}</s-table-cell>
                <s-table-cell>
                  <LogStatusBadge status={log.status} />
                </s-table-cell>
                <s-table-cell>
                  <s-text tone={log.status === "error" ? "critical" : undefined}>
                    {log.message || "—"}
                  </s-text>
                </s-table-cell>
                <s-table-cell>{formatDateTime(log.createdAt)}</s-table-cell>
                <s-table-cell>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    icon="delete"
                    accessibilityLabel="Delete this entry"
                    loading={deletingId === log.id || undefined}
                    disabled={(busy && deletingId !== log.id) || undefined}
                    onClick={() => remove({ intent: "delete-one", id: log.id })}
                  />
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>

        {logs.length === 0 && (
          <s-box padding="base">
            <s-text color="subdued">No activity to show.</s-text>
          </s-box>
        )}

        <s-box padding="base">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center">
            <s-text color="subdued">
              {total} event{total === 1 ? "" : "s"} · page {page} of {pageCount}
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
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
