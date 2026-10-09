import { useEffect } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

const SYNC_STATUS = {
  synced: { tone: "success", label: "Synced" },
  pending: { tone: "info", label: "Pending" },
  error: { tone: "critical", label: "Error" },
};

const LOG_STATUS = {
  success: { tone: "success", label: "Success" },
  error: { tone: "critical", label: "Failed" },
};

const DIRECTION_LABEL = {
  kogan_to_shopify: "Kogan → Shopify",
  shopify_to_kogan: "Shopify → Kogan",
};

const ACTION_LABEL = {
  import: "Import",
  push: "Push",
  create: "Create",
  update: "Update",
  delete: "Delete",
  order: "Order",
  dispatch: "Dispatch",
  cancel: "Cancel",
};

export function SyncStatusBadge({ status }) {
  const config = SYNC_STATUS[status] || { tone: "neutral", label: status || "Unknown" };
  return <s-badge tone={config.tone}>{config.label}</s-badge>;
}

export function LogStatusBadge({ status }) {
  const config = LOG_STATUS[status] || { tone: "neutral", label: status };
  return <s-badge tone={config.tone}>{config.label}</s-badge>;
}

export function ProductStatusBadge({ status }) {
  if (status === "ACTIVE") return <s-badge tone="success">Active</s-badge>;
  if (status === "DRAFT") return <s-badge tone="info">Draft</s-badge>;
  if (status === "ARCHIVED") return <s-badge tone="neutral">Archived</s-badge>;
  return <s-badge tone="critical">Deleted</s-badge>;
}

export function directionLabel(direction) {
  return DIRECTION_LABEL[direction] || direction;
}

export function actionLabel(action) {
  return ACTION_LABEL[action] || action;
}

export function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRelative(value) {
  if (!value) return "Never";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDateTime(value);
}

export function adminProductUrl(productId) {
  return `shopify://admin/products/${String(productId).split("/").pop()}`;
}

export function adminOrderUrl(orderId) {
  return `shopify://admin/orders/${String(orderId).split("/").pop()}`;
}

const IMPORT_STATUS = {
  new: { tone: "neutral", label: "Not imported" },
  imported: { tone: "success", label: "Imported" },
  updated: { tone: "success", label: "Updated" },
  exists: { tone: "warning", label: "Already exists" },
  failed: { tone: "critical", label: "Failed" },
};

export function ImportStatusBadge({ status }) {
  const config = IMPORT_STATUS[status] || IMPORT_STATUS.new;
  return <s-badge tone={config.tone}>{config.label}</s-badge>;
}

const ORDER_STATUS = {
  creating: { tone: "info", label: "Processing" },
  imported: { tone: "caution", label: "Awaiting dispatch" },
  partially_dispatched: { tone: "warning", label: "Partially dispatched" },
  dispatched: { tone: "success", label: "Dispatched" },
  cancelled: { tone: "neutral", label: "Cancelled" },
  error: { tone: "critical", label: "Error" },
};

export function OrderStatusBadge({ status }) {
  const config = ORDER_STATUS[status] || { tone: "neutral", label: status };
  return <s-badge tone={config.tone}>{config.label}</s-badge>;
}

/**
 * Re-runs the route loaders every two seconds while a background job runs.
 */
export function useJobPolling(job) {
  const revalidator = useRevalidator();

  useEffect(() => {
    if (job?.status !== "running") return undefined;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2000);
    return () => clearInterval(timer);
  }, [job?.status, revalidator]);
}

export function JobBanner({ job }) {
  if (!job) return null;

  const isImport = job.type === "import";
  const label = isImport ? "Import from Kogan" : "Push to Kogan";

  if (job.status === "running") {
    // Kogan does not report a catalogue size, so imports show an open-ended
    // progress bar with running totals instead of a percentage.
    const percent = !isImport && job.total > 0 ? Math.round((job.processed / job.total) * 100) : undefined;
    const counts = isImport
      ? `${job.processed} products checked · ${job.created} imported · ${job.skipped} already existed · ${job.failed} failed`
      : `${job.processed} of ${job.total} products processed · ${job.created} created · ${job.updated} updated · ${job.failed} failed`;

    return (
      <s-section heading={`${label} in progress`}>
        <s-stack gap="small-200">
          <s-progress value={percent} max={100} tone="info" accessibilityLabel={`${label} progress`} />
          <s-text color="subdued">
            {job.processed > 0 ? counts : "Connecting to Kogan and reading your product catalogue…"}
          </s-text>
          <s-text color="subdued">
            You can leave this page. The sync keeps running in the background.
          </s-text>
        </s-stack>
      </s-section>
    );
  }

  const tone =
    job.status === "completed"
      ? "success"
      : job.status === "completed_with_errors"
        ? "warning"
        : "critical";

  const title =
    job.status === "completed"
      ? `${label} finished`
      : job.status === "completed_with_errors"
        ? `${label} finished with ${job.failed} error${job.failed === 1 ? "" : "s"}`
        : `${label} failed`;

  return (
    <s-banner tone={tone} heading={title}>
      {job.message}{" "}
      {job.failed > 0 && <s-link href="/app/activity?status=error">View errors</s-link>}
      <s-text color="subdued"> · {formatRelative(job.finishedAt)}</s-text>
    </s-banner>
  );
}

/**
 * Deletes activity entries through /api/activity and shows the result as a
 * toast. The current page reloads its data automatically afterwards.
 */
export function useActivityDelete() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const remove = (fields) =>
    fetcher.submit(fields, { method: "post", action: "/api/activity" });

  const deletingId =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "delete-one"
      ? fetcher.formData.get("id")
      : null;

  return { remove, busy: fetcher.state !== "idle", deletingId };
}
