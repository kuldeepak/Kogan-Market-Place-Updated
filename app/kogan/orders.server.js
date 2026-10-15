import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { createKoganClient } from "./kogan-client.server";
import { findVariantsBySkus } from "./shopify-products.server";
import {
  cancelShopifyOrder,
  createOrderFromKogan,
  fulfillOrderItems,
  getOrderState,
} from "./shopify-orders.server";
import { getSettings, hasKoganCredentials, logSync, saveSettings } from "./store.server";
import { checkPendingKoganTasks, verifyKoganState } from "./sync.server";
import { ensureCategories } from "./categories.server";

const POLL_TICK_MS = 60 * 1000;
const CANCELLED_LOOKBACK_DAYS = 14;

const SHOPIFY_TO_KOGAN_CANCEL_REASON = {
  customer: "BuyerCanceled",
  inventory: "ItemNotAvailable",
};

const runningSyncs = new Set();

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function orderStatus(items) {
  const total = items.reduce((sum, item) => sum + item.quantity, 0);
  const dispatched = items.reduce((sum, item) => sum + item.dispatched, 0);
  const cancelled = items.reduce((sum, item) => sum + item.cancelled, 0);

  if (cancelled >= total) return "cancelled";
  if (dispatched + cancelled >= total) return "dispatched";
  if (dispatched > 0) return "partially_dispatched";
  return "imported";
}

function customerName(order) {
  const address = order.ShippingAddress || order.BuyerAddress || {};
  return [address.FirstName, address.LastName].filter(Boolean).join(" ") || null;
}

// ---------------------------------------------------------------------------
// Kogan -> Shopify: new and cancelled orders
// ---------------------------------------------------------------------------

async function resolveVariants(admin, shop, skus) {
  const variants = new Map();
  const links = await prisma.koganProductLink.findMany({
    where: { shop, koganSku: { in: skus }, shopifyVariantId: { not: null } },
  });

  for (const link of links) {
    variants.set(link.koganSku, { variantId: link.shopifyVariantId });
  }

  const missing = skus.filter((sku) => !variants.has(sku));
  if (missing.length > 0) {
    for (const [sku, match] of await findVariantsBySkus(admin, missing)) {
      variants.set(sku, { variantId: match.variantId });
    }
  }

  return variants;
}

async function importKoganOrder(admin, shop, settings, order, existingRow) {
  const items = order.Items.map((item) => ({
    id: String(item.ID),
    sku: item.SellerSku,
    quantity: item.Quantity,
    unitPrice: item.UnitPrice,
    dispatched: 0,
    cancelled: 0,
  }));

  const rowData = {
    orderLabel: order.OrderLabel ? String(order.OrderLabel) : null,
    currency: order.Currency,
    totalPrice: Number(order.TotalPrice || 0).toFixed(2),
    customerName: customerName(order),
    items: JSON.stringify(items),
    orderDate: new Date(order.OrderDateUtc),
  };

  // Reserve the row first so overlapping runs never create the order twice.
  const row =
    existingRow ||
    (await prisma.koganOrder.create({
      data: { shop, koganOrderId: String(order.ID), status: "creating", ...rowData },
    }));

  try {
    const variantsBySku = await resolveVariants(admin, shop, items.map((item) => item.sku));
    const created = await createOrderFromKogan(admin, {
      order,
      variantsBySku,
      tags: [settings.syncTag, "Kogan order"],
    });

    const unmatched = items.filter((item) => !variantsBySku.has(item.sku)).map((item) => item.sku);

    await prisma.koganOrder.update({
      where: { id: row.id },
      data: {
        ...rowData,
        shopifyOrderId: created.id,
        shopifyName: created.name,
        status: "imported",
        error: null,
      },
    });

    await logSync(shop, {
      direction: "kogan_to_shopify",
      action: "order",
      status: "success",
      title: `Kogan order ${rowData.orderLabel || order.ID}`,
      sku: items.map((item) => item.sku).join(", "),
      message: unmatched.length
        ? `Created Shopify order ${created.name}. No Shopify product found for SKU ${unmatched.join(", ")}, so those lines were added as custom items.`
        : `Created Shopify order ${created.name}`,
    });

    return true;
  } catch (error) {
    await prisma.koganOrder.update({
      where: { id: row.id },
      data: { ...rowData, status: "error", error: error.message.slice(0, 2000) },
    });
    await logSync(shop, {
      direction: "kogan_to_shopify",
      action: "order",
      status: "error",
      title: `Kogan order ${rowData.orderLabel || order.ID}`,
      message: error.message,
    });
    return false;
  }
}

async function applyKoganCancellations(admin, shop, kogan) {
  const end = new Date();
  const start = new Date(end.getTime() - CANCELLED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const cancelledOrders = await kogan.getOrders("Canceled", {
    startDateUTC: start.toISOString(),
    endDateUTC: end.toISOString(),
  });

  if (cancelledOrders.length === 0) return 0;

  const rows = await prisma.koganOrder.findMany({
    where: {
      shop,
      koganOrderId: { in: cancelledOrders.map((order) => String(order.ID)) },
      status: { notIn: ["cancelled", "dispatched"] },
    },
  });

  let cancelled = 0;

  for (const row of rows) {
    const items = parseJson(row.items, []).map((item) => ({
      ...item,
      cancelled: item.quantity - item.dispatched,
    }));

    // Mark the row first so the orders/cancelled webhook that our own cancel
    // triggers is recognised and not sent back to Kogan.
    await prisma.koganOrder.update({
      where: { id: row.id },
      data: { status: "cancelled", items: JSON.stringify(items) },
    });

    try {
      if (row.shopifyOrderId) {
        const state = await getOrderState(admin, row.shopifyOrderId);
        if (state && !state.cancelledAt) {
          await cancelShopifyOrder(admin, row.shopifyOrderId, "Cancelled on Kogan");
        }
      }
      cancelled += 1;
      await logSync(shop, {
        direction: "kogan_to_shopify",
        action: "cancel",
        status: "success",
        title: `Kogan order ${row.orderLabel || row.koganOrderId}`,
        message: `Cancelled on Kogan, so Shopify order ${row.shopifyName || ""} was cancelled and restocked.`,
      });
    } catch (error) {
      await logSync(shop, {
        direction: "kogan_to_shopify",
        action: "cancel",
        status: "error",
        title: `Kogan order ${row.orderLabel || row.koganOrderId}`,
        message: error.message,
      });
    }
  }

  return cancelled;
}

// ---------------------------------------------------------------------------
// Kogan -> Shopify: orders dispatched on Kogan
// ---------------------------------------------------------------------------

const DISPATCH_LOOKBACK_DAYS = 14;

/**
 * Kogan returns shipped orders for at most 15 days at a time, so the last
 * 14 days of Shipped and PartiallyShipped orders are read on every sync.
 */
async function fetchDispatchedOrders(kogan) {
  const end = new Date();
  const start = new Date(end.getTime() - DISPATCH_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const range = { startDateUTC: start.toISOString(), endDateUTC: end.toISOString() };

  const [shipped, partial] = await Promise.all([
    kogan.getOrders("Shipped", range),
    kogan.getOrders("PartiallyShipped", range),
  ]);

  return [...new Map([...shipped, ...partial].map((order) => [String(order.ID), order])).values()];
}

function latestDispatchDate(order) {
  const dates = (order.DispatchedItems || [])
    .map((line) => new Date(line.DispatchDateUtc).getTime())
    .filter(Number.isFinite);
  return dates.length > 0 ? new Date(Math.max(...dates)) : null;
}

/**
 * Works out which units Kogan has dispatched that Shopify does not know about
 * yet, grouped by tracking number so each parcel becomes one fulfillment.
 */
function newDispatches(items, order) {
  const groups = new Map();

  for (const item of items) {
    const lines = (order.DispatchedItems || [])
      .filter((line) => String(line.ID) === item.id)
      .sort((a, b) => new Date(a.DispatchDateUtc) - new Date(b.DispatchDateUtc));

    const koganTotal = lines.reduce((sum, line) => sum + (Number(line.Quantity) || 0), 0);
    let missing = Math.min(koganTotal, item.quantity - item.cancelled) - item.dispatched;
    let alreadyCounted = item.dispatched;

    for (const line of lines) {
      if (missing <= 0) break;
      const available = Number(line.Quantity) || 0;
      if (alreadyCounted >= available) {
        alreadyCounted -= available;
        continue;
      }

      const quantity = Math.min(available - alreadyCounted, missing);
      alreadyCounted = 0;
      missing -= quantity;

      const key = `${line.TrackingNumber || ""}|${line.Carrier || ""}`;
      const group = groups.get(key) || {
        tracking: line.TrackingNumber || null,
        carrier: line.Carrier || null,
        at: line.DispatchDateUtc || new Date().toISOString(),
        lines: [],
      };
      group.lines.push({ item, quantity });
      groups.set(key, group);
    }
  }

  return [...groups.values()];
}

function describeTracking(group) {
  if (group.tracking) return `${group.carrier || "tracking"} ${group.tracking}`;
  return group.carrier ? `${group.carrier} (no tracking number)` : "no tracking number";
}

/**
 * Marks a Shopify order as fulfilled for the units Kogan has dispatched.
 * The dispatch is written to the app's records before the Shopify
 * fulfillment is created, so the fulfillments/create webhook that follows
 * finds nothing left to send and never echoes the dispatch back to Kogan.
 */
async function applyDispatchToShopify(admin, shop, row, order) {
  const items = parseJson(row.items, []);
  const groups = newDispatches(items, order);
  if (groups.length === 0) return false;

  const before = row.items;
  for (const group of groups) {
    for (const { item, quantity } of group.lines) {
      item.dispatched += quantity;
      item.dispatches = [
        ...(item.dispatches || []),
        { quantity, carrier: group.carrier, tracking: group.tracking, at: group.at, source: "kogan" },
      ];
    }
  }

  await prisma.koganOrder.update({
    where: { id: row.id },
    data: { items: JSON.stringify(items), status: orderStatus(items) },
  });

  const title = `Kogan order ${row.orderLabel || row.koganOrderId}`;
  const fulfillmentIds = [];

  try {
    for (const group of groups) {
      try {
        const ids = await fulfillOrderItems(
          admin,
          row.shopifyOrderId,
          group.lines.map(({ item, quantity }) => ({ sku: item.sku, quantity })),
          { number: group.tracking, company: group.carrier },
        );
        fulfillmentIds.push(...ids.map((id) => id.split("/").pop()));
      } catch (error) {
        // Fulfilled by hand in Shopify already: nothing to undo.
        if (!/nothing left to fulfil/i.test(error.message)) throw error;
      }
    }

    await prisma.koganOrder.update({
      where: { id: row.id },
      data: {
        fulfillmentIds: JSON.stringify([...parseJson(row.fulfillmentIds, []), ...fulfillmentIds]),
        error: null,
      },
    });

    await logSync(shop, {
      direction: "kogan_to_shopify",
      action: "dispatch",
      status: "success",
      title,
      sku: groups.flatMap((group) => group.lines.map(({ item }) => item.sku)).join(", "),
      message: `Dispatched on Kogan with ${groups.map(describeTracking).join(", ")}, so Shopify order ${row.shopifyName || ""} was marked as fulfilled.`,
    });
    return true;
  } catch (error) {
    await prisma.koganOrder.update({
      where: { id: row.id },
      data: {
        items: before,
        status: orderStatus(parseJson(before, [])),
        error: `Could not mark the Shopify order as fulfilled: ${error.message}`.slice(0, 2000),
      },
    });
    await logSync(shop, {
      direction: "kogan_to_shopify",
      action: "dispatch",
      status: "error",
      title,
      message: `Dispatched on Kogan, but Shopify order ${row.shopifyName || ""} could not be marked as fulfilled: ${error.message}`,
    });
    return false;
  }
}

/**
 * Brings orders that were dispatched on Kogan into Shopify. Orders Shopify
 * does not have yet are created and fulfilled; orders that are already in
 * Shopify are fulfilled with Kogan's tracking details. Orders dispatched
 * before `dispatchedOrdersFrom` are left alone, so turning the feature on does
 * not flood Shopify with old orders or take their stock again.
 */
async function applyKoganDispatches(admin, shop, settings, kogan, summary) {
  if (!settings.importDispatchedOrders) return;

  let from = settings.dispatchedOrdersFrom ? new Date(settings.dispatchedOrdersFrom) : null;
  if (!from) {
    from = new Date();
    await saveSettings(shop, { dispatchedOrdersFrom: from });
  }

  const orders = await fetchDispatchedOrders(kogan);
  if (orders.length === 0) return;

  const rows = await prisma.koganOrder.findMany({
    where: { shop, koganOrderId: { in: orders.map((order) => String(order.ID)) } },
  });
  const rowsById = new Map(rows.map((row) => [row.koganOrderId, row]));

  for (const order of orders) {
    let row = rowsById.get(String(order.ID));
    if (row?.status === "creating" || row?.status === "cancelled") continue;

    if (!row?.shopifyOrderId) {
      const dispatchedAt = latestDispatchDate(order) || new Date(order.OrderDateUtc);
      if (dispatchedAt < from) continue;

      const ok = await importKoganOrder(admin, shop, settings, order, row);
      if (!ok) {
        summary.failed += 1;
        continue;
      }
      summary.imported += 1;
      row = await prisma.koganOrder.findFirst({ where: { shop, koganOrderId: String(order.ID) } });
    }

    if (await applyDispatchToShopify(admin, shop, row, order)) {
      summary.dispatched += 1;
    }
  }
}

/**
 * Pulls open Kogan orders into Shopify, applies dispatches made on Kogan and
 * Kogan-side cancellations.
 * Kogan has no order webhooks, so this runs on a schedule and on demand.
 */
export async function syncKoganOrders(shop) {
  if (runningSyncs.has(shop)) {
    return { imported: 0, dispatched: 0, cancelled: 0, failed: 0, alreadyRunning: true };
  }
  runningSyncs.add(shop);

  const settings = await getSettings(shop);
  const summary = { imported: 0, dispatched: 0, cancelled: 0, failed: 0 };

  try {
    const kogan = createKoganClient(settings);
    const { admin } = await unauthenticated.admin(shop);
    const openOrders = await kogan.getOrders("ReleasedForShipment");

    const rows = await prisma.koganOrder.findMany({
      where: { shop, koganOrderId: { in: openOrders.map((order) => String(order.ID)) } },
    });
    const rowsById = new Map(rows.map((row) => [row.koganOrderId, row]));

    for (const order of openOrders) {
      const row = rowsById.get(String(order.ID));
      if (row && row.status !== "error") continue;

      const ok = await importKoganOrder(admin, shop, settings, order, row);
      summary[ok ? "imported" : "failed"] += 1;
    }

    await applyKoganDispatches(admin, shop, settings, kogan, summary);
    summary.cancelled = await applyKoganCancellations(admin, shop, kogan);

    await saveSettings(shop, { lastOrderSyncAt: new Date(), lastOrderSyncError: null });
    return summary;
  } catch (error) {
    if (settings.lastOrderSyncError !== error.message) {
      await logSync(shop, {
        direction: "kogan_to_shopify",
        action: "order",
        status: "error",
        message: error.message,
      });
    }
    await saveSettings(shop, {
      lastOrderSyncAt: new Date(),
      lastOrderSyncError: error.message.slice(0, 2000),
    });
    throw error;
  } finally {
    runningSyncs.delete(shop);
  }
}

// ---------------------------------------------------------------------------
// Shopify -> Kogan: dispatch and cancellation
// ---------------------------------------------------------------------------

/**
 * Sends a Shopify fulfillment of a Kogan order to Kogan as a dispatch, with
 * the tracking number and carrier entered in Shopify.
 */
export async function handleFulfillmentCreated(shop, payload) {
  if (!payload?.order_id || ["cancelled", "failure", "error"].includes(payload.status)) return;

  const row = await prisma.koganOrder.findFirst({
    where: { shop, shopifyOrderId: `gid://shopify/Order/${payload.order_id}` },
  });
  if (!row) return;

  const fulfillmentId = String(payload.id);
  const processed = parseJson(row.fulfillmentIds, []);
  if (processed.includes(fulfillmentId)) return;

  const items = parseJson(row.items, []);
  const trackingNumber = payload.tracking_number || payload.tracking_numbers?.[0] || undefined;
  const carrier = payload.tracking_company || undefined;
  const shippedAt = new Date(payload.created_at || Date.now()).toISOString();
  const lines = [];

  for (const lineItem of payload.line_items || []) {
    const item = items.find((entry) => entry.sku === lineItem.sku?.trim());
    if (!item) continue;

    const remaining = item.quantity - item.dispatched - item.cancelled;
    const quantity = Math.min(lineItem.quantity, remaining);
    if (quantity <= 0) continue;

    lines.push({ item, quantity });
  }

  if (lines.length === 0) return;

  const title = `Kogan order ${row.orderLabel || row.koganOrderId}`;

  try {
    const kogan = createKoganClient(await getSettings(shop));
    const problems = await kogan.fulfillOrders([
      {
        ID: row.koganOrderId,
        Items: lines.map(({ item, quantity }) => ({
          OrderItemID: item.id,
          SellerSku: item.sku,
          Quantity: quantity,
          ShippedDateUtc: shippedAt,
          TrackingNumber: trackingNumber,
          ShippingCarrier: carrier,
        })),
      },
    ]);

    if (problems.length > 0) {
      throw new Error(problems.join(" | "));
    }

    for (const { item, quantity } of lines) {
      item.dispatched += quantity;
      item.dispatches = [
        ...(item.dispatches || []),
        { quantity, carrier: carrier || null, tracking: trackingNumber || null, at: shippedAt, source: "shopify" },
      ];
    }

    await prisma.koganOrder.update({
      where: { id: row.id },
      data: {
        items: JSON.stringify(items),
        fulfillmentIds: JSON.stringify([...processed, fulfillmentId]),
        status: orderStatus(items),
        error: null,
      },
    });

    await logSync(shop, {
      direction: "shopify_to_kogan",
      action: "dispatch",
      status: "success",
      title,
      sku: lines.map(({ item }) => item.sku).join(", "),
      message: trackingNumber
        ? `Dispatched on Kogan with ${carrier || "tracking"} ${trackingNumber}`
        : "Dispatched on Kogan (no tracking number was entered in Shopify)",
    });
  } catch (error) {
    await prisma.koganOrder.update({
      where: { id: row.id },
      data: { error: `Dispatch failed: ${error.message}`.slice(0, 2000) },
    });
    await logSync(shop, {
      direction: "shopify_to_kogan",
      action: "dispatch",
      status: "error",
      title,
      message: error.message,
    });
  }
}

/**
 * Cancels the unshipped items of a Kogan order when its Shopify order is
 * cancelled. Kogan refunds the customer itself.
 */
export async function handleOrderCancelled(shop, payload) {
  if (!payload?.id) return;

  const row = await prisma.koganOrder.findFirst({
    where: { shop, shopifyOrderId: `gid://shopify/Order/${payload.id}` },
  });
  if (!row || row.status === "cancelled") return;

  const items = parseJson(row.items, []);
  const reason = SHOPIFY_TO_KOGAN_CANCEL_REASON[payload.cancel_reason] || "Other";
  const toCancel = items
    .map((item) => ({ item, quantity: item.quantity - item.dispatched - item.cancelled }))
    .filter(({ quantity }) => quantity > 0);

  if (toCancel.length === 0) return;

  const title = `Kogan order ${row.orderLabel || row.koganOrderId}`;

  try {
    const kogan = createKoganClient(await getSettings(shop));
    await kogan.cancelOrder(
      row.koganOrderId,
      toCancel.map(({ item, quantity }) => ({
        ID: item.id,
        SellerSku: item.sku,
        Quantity: quantity,
        Reason: reason,
      })),
    );

    for (const { item, quantity } of toCancel) {
      item.cancelled += quantity;
    }

    await prisma.koganOrder.update({
      where: { id: row.id },
      data: { items: JSON.stringify(items), status: orderStatus(items), error: null },
    });

    await logSync(shop, {
      direction: "shopify_to_kogan",
      action: "cancel",
      status: "success",
      title,
      message: `Cancelled on Kogan (reason: ${reason}). Kogan will refund the customer.`,
    });
  } catch (error) {
    await prisma.koganOrder.update({
      where: { id: row.id },
      data: { error: `Cancellation failed: ${error.message}`.slice(0, 2000) },
    });
    await logSync(shop, {
      direction: "shopify_to_kogan",
      action: "cancel",
      status: "error",
      title,
      message: error.message,
    });
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

async function pollDueShops() {
  const sessions = await prisma.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });

  for (const { shop } of sessions) {
    const settings = await getSettings(shop);
    if (!hasKoganCredentials(settings)) continue;

    await checkPendingKoganTasks(shop).catch((error) =>
      console.error(`Kogan task check failed for ${shop}:`, error.message),
    );
    await verifyKoganState(shop).catch((error) =>
      console.error(`Kogan verification failed for ${shop}:`, error.message),
    );
    await ensureCategories(settings).catch((error) =>
      console.error(`Kogan category check failed for ${shop}:`, error.message),
    );

    if (!settings.orderSyncEnabled) continue;

    const intervalMs = Math.max(1, settings.orderSyncMinutes) * 60 * 1000;
    const lastRun = settings.lastOrderSyncAt ? new Date(settings.lastOrderSyncAt).getTime() : 0;
    if (Date.now() - lastRun < intervalMs) continue;

    await syncKoganOrders(shop).catch((error) =>
      console.error(`Kogan order sync failed for ${shop}:`, error.message),
    );
  }
}

/**
 * Starts the background order poller once per server process. The timer is
 * kept on the Node global object so a hot reload in development replaces it instead of
 * starting a second one.
 */
export function startOrderPolling() {
  if (global.koganOrderPoller) {
    clearInterval(global.koganOrderPoller);
  }

  const tick = () =>
    pollDueShops().catch((error) => console.error("Kogan order polling failed:", error));

  global.koganOrderPoller = setInterval(tick, POLL_TICK_MS);
  setTimeout(tick, 15 * 1000);
}
