import { useEffect, useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings, getRecentLogs, hasKoganCredentials } from "../kogan/store.server";
import { getLatestJob, startImportJob, startPushAllJob } from "../kogan/sync.server";
import {
  JobBanner,
  LogStatusBadge,
  actionLabel,
  directionLabel,
  formatRelative,
  useActivityDelete,
  useJobPolling,
} from "../components/sync-ui";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await getSettings(shop);

  const [linked, errors, latestJob, recentLogs, lastSync, openOrders] = await Promise.all([
    prisma.koganProductLink.count({ where: { shop } }),
    prisma.koganProductLink.count({ where: { shop, syncStatus: "error" } }),
    getLatestJob(shop),
    getRecentLogs(shop, 8),
    prisma.koganProductLink.findFirst({
      where: { shop, lastSyncedAt: { not: null } },
      orderBy: { lastSyncedAt: "desc" },
      select: { lastSyncedAt: true },
    }),
    prisma.koganOrder.count({
      where: { shop, status: { in: ["imported", "partially_dispatched"] } },
    }),
  ]);

  return {
    configured: hasKoganCredentials(settings),
    syncTag: settings.syncTag,
    autoSyncEnabled: settings.autoSyncEnabled,
    stats: { linked, errors, openOrders, lastSyncedAt: lastSync?.lastSyncedAt ?? null },
    lastOrderSyncError: settings.lastOrderSyncError,
    latestJob,
    recentLogs,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const intent = (await request.formData()).get("intent");

  const job =
    intent === "push"
      ? await startPushAllJob(session.shop)
      : await startImportJob(session.shop);

  return { jobId: job.id, type: job.type };
};

function ConnectionBanner({ status, configured }) {
  if (!configured) {
    return (
      <s-banner tone="critical" heading="Connect your Kogan seller account">
        Add your Kogan Seller ID and Seller Token to start syncing.{" "}
        <s-link href="/app/settings">Open settings</s-link>
      </s-banner>
    );
  }

  if (!status) {
    return (
      <s-banner tone="info">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-spinner size="base" accessibilityLabel="Checking connection" />
          Checking the connection to Kogan…
        </s-stack>
      </s-banner>
    );
  }

  if (!status.connected) {
    return (
      <s-banner tone="critical" heading="Kogan connection failed">
        {status.message} <s-link href="/app/settings">Check your credentials</s-link>
      </s-banner>
    );
  }

  return null;
}

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

export default function Dashboard() {
  const { configured, syncTag, autoSyncEnabled, stats, latestJob, recentLogs, lastOrderSyncError } =
    useLoaderData();
  const jobFetcher = useFetcher();
  const statusFetcher = useFetcher();
  const shopify = useAppBridge();
  const previousJobStatus = useRef(latestJob?.status);

  const running = latestJob?.status === "running" || jobFetcher.state !== "idle";

  useEffect(() => {
    if (configured) statusFetcher.load("/api/kogan-status");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  useJobPolling(latestJob);
  const { remove, busy, deletingId } = useActivityDelete();

  useEffect(() => {
    if (previousJobStatus.current === "running" && latestJob?.status !== "running") {
      shopify.toast.show(
        latestJob?.status === "failed" ? "Sync failed" : "Sync finished",
        { isError: latestJob?.status === "failed" },
      );
    }
    previousJobStatus.current = latestJob?.status;
  }, [latestJob?.status, shopify]);

  const connected = statusFetcher.data?.connected;
  const canSync = configured && connected !== false && !running;

  const start = (intent) => jobFetcher.submit({ intent }, { method: "post" });

  return (
    <s-page heading="Kogan Marketplace Sync">
      <s-button
        slot="primary-action"
        variant="primary"
        href="/app/import"
        disabled={!configured || undefined}
      >
        Import products
      </s-button>
      <s-button
        slot="secondary-actions"
        onClick={() => start("push")}
        disabled={!canSync || undefined}
      >
        Push all to Kogan
      </s-button>

      <s-stack gap="base">
        <ConnectionBanner status={statusFetcher.data} configured={configured} />
        <JobBanner job={latestJob} />

        <s-section heading="Overview">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
            <StatCard
              label="Kogan connection"
              value={
                !configured ? "Not set up" : !statusFetcher.data ? "Checking…" : connected ? "Connected" : "Error"
              }
              detail={connected ? `Seller ${statusFetcher.data.sellerId}` : null}
            />
            <StatCard label="Linked products" value={stats.linked} detail={`Tagged "${syncTag}"`} />
            <StatCard
              label="Sync errors"
              value={stats.errors}
              detail={stats.errors > 0 ? "Needs attention" : "All good"}
            />
            <StatCard
              label="Kogan orders"
              value={stats.openOrders}
              detail={lastOrderSyncError ? "Order sync has an error" : "Awaiting dispatch"}
            />
            <StatCard
              label="Automatic sync"
              value={autoSyncEnabled ? "On" : "Off"}
              detail={`Last sync ${formatRelative(stats.lastSyncedAt).toLowerCase()}`}
            />
          </s-grid>
        </s-section>

        <s-section heading="Recent activity">
          <s-button slot="secondary-actions" variant="tertiary" href="/app/activity">
            View all
          </s-button>
          <s-button
            slot="secondary-actions"
            variant="tertiary"
            tone="critical"
            commandFor="clear-activity-modal"
            command="--show"
            disabled={recentLogs.length === 0 || busy || undefined}
          >
            Clear all
          </s-button>
          <s-modal id="clear-activity-modal" heading="Delete all activity?">
            <s-paragraph>
              The whole activity history is deleted permanently. Products, orders and sync
              settings are not changed.
            </s-paragraph>
            <s-button
              slot="primary-action"
              variant="primary"
              tone="critical"
              commandFor="clear-activity-modal"
              command="--hide"
              onClick={() => remove({ intent: "delete-filter", filter: "all" })}
            >
              Delete all
            </s-button>
            <s-button slot="secondary-actions" commandFor="clear-activity-modal" command="--hide">
              Cancel
            </s-button>
          </s-modal>
          {recentLogs.length === 0 ? (
            <s-text color="subdued">
              No activity yet. Click “Import products” to bring your Kogan products into Shopify.
            </s-text>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header>Direction</s-table-header>
                <s-table-header>Action</s-table-header>
                <s-table-header listSlot="secondary">Result</s-table-header>
                <s-table-header>When</s-table-header>
                <s-table-header>
                  <s-text accessibilityVisibility="exclusive">Actions</s-text>
                </s-table-header>
              </s-table-header-row>
              <s-table-body>
                {recentLogs.map((log) => (
                  <s-table-row key={log.id}>
                    <s-table-cell>
                      <s-stack gap="small-300">
                        <s-text type="strong">{log.title || log.sku || "—"}</s-text>
                        <s-text color="subdued">{log.message}</s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{directionLabel(log.direction)}</s-table-cell>
                    <s-table-cell>{actionLabel(log.action)}</s-table-cell>
                    <s-table-cell>
                      <LogStatusBadge status={log.status} />
                    </s-table-cell>
                    <s-table-cell>{formatRelative(log.createdAt)}</s-table-cell>
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
          )}
        </s-section>
      </s-stack>

      <s-section slot="aside" heading="How it works">
        <s-ordered-list>
          <s-list-item>
            <s-text type="strong">Import products</s-text> lists your Kogan catalogue 10 products
            per page. Products whose SKU is already in Shopify are marked “Already exists” and are
            never duplicated.
          </s-list-item>
          <s-list-item>
            When you edit a “{syncTag}” product in Shopify (title, description, price, stock,
            images, status), the change is sent to Kogan automatically within a few seconds.
          </s-list-item>
          <s-list-item>
            Add the “{syncTag}” tag to any other Shopify product to list it on Kogan. It needs a
            SKU, a price, an image and a Kogan category.
          </s-list-item>
          <s-list-item>
            <s-text type="strong">Push all to Kogan</s-text> re-checks every tagged product and sends
            anything that is out of date.
          </s-list-item>
          <s-list-item>
            Deleting a “{syncTag}” product in Shopify removes it from sale on Kogan.
          </s-list-item>
          <s-list-item>
            Kogan orders are created in Shopify automatically. Fulfil them in Shopify and the
            tracking details are sent to Kogan.
          </s-list-item>
        </s-ordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
