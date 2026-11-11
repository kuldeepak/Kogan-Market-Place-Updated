import prisma from "../db.server";

export const SUPPORTED_CURRENCIES = ["AUD", "NZD"];

const SETTINGS_DEFAULTS = {
  sellerId: null,
  sellerToken: null,
  apiBaseUrl: null,
  syncTag: "Kogan",
  currency: "AUD",
  defaultCategory: null,
  handlingDays: 2,
  productLocation: null,
  koganShipping: null,
  autoSyncEnabled: true,
  createOnKogan: true,
  zeroStockOnDelete: true,
  importAsActive: true,
  autoGenerateSkus: true,
  importDispatchedOrders: true,
  dispatchedOrdersFrom: null,
  dispatchCarrier: null,
  koganOrderLocation: null,
  koganFirstDiscount: null,
  koganOrderMethod: null,
};

export async function getSettings(shop) {
  const settings = await prisma.koganSettings.findUnique({ where: { shop } });
  return { ...SETTINGS_DEFAULTS, shop, ...(settings || {}) };
}

export function saveSettings(shop, data) {
  return prisma.koganSettings.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });
}

/**
 * True when the shop has its own credentials or the server has fallback
 * credentials configured in the environment.
 */
export function hasKoganCredentials(settings) {
  return Boolean(
    (settings.sellerId || process.env.KOGAN_SELLER_ID) &&
      (settings.sellerToken || process.env.KOGAN_SELLER_TOKEN),
  );
}

export function hasEnvCredentials() {
  return Boolean(process.env.KOGAN_SELLER_ID && process.env.KOGAN_SELLER_TOKEN);
}

/**
 * How shipping is charged on Kogan. Kogan's "shipping" offer field is a
 * carton rate: "0" means free shipping, and an empty value means variable
 * shipping, calculated by Kogan from the shipping matrix the seller gave them
 * and each product's weight. Free shipping is the default; koganShipping is
 * empty until the option has been saved or applied to Kogan once.
 */
export const SHIPPING_MODES = ["free", "variable"];

export function shippingModeOf(settings) {
  return settings.koganShipping === "variable" ? "variable" : "free";
}

/** The value sent to Kogan as offer_data.<currency>.shipping. */
export function koganShippingValue(settings) {
  return shippingModeOf(settings) === "free" ? "0.00" : null;
}

/**
 * Kogan FIRST (Mighty Ape Primate) pricing managed from Settings. Kogan takes
 * a per-SKU "kogan_first_price" in each offer. Kogan's rules: a Kogan FIRST
 * discount must be at least $2 or 3% of the normal price, whichever is
 * greater, and when a store-wide discount is also set on Kogan's side, the
 * larger discount is shown. An empty setting means the app does not manage
 * Kogan FIRST prices at all (nothing is sent).
 */
export const KOGAN_FIRST_MIN_PERCENT = 3;
export const KOGAN_FIRST_MAX_PERCENT = 90;
const KOGAN_FIRST_MIN_AMOUNT = 2;

/** The saved Kogan FIRST discount as a normalised percentage ("5", "7.5"), or null. */
export function koganFirstPercent(settings) {
  const raw = settings?.koganFirstDiscount;
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < KOGAN_FIRST_MIN_PERCENT || value > KOGAN_FIRST_MAX_PERCENT) return null;
  return String(Math.round(value * 100) / 100);
}

/**
 * The Kogan FIRST price for a normal price and a discount percentage, rounded
 * down to the cent so the discount never falls below Kogan's minimum. Returns
 * null when there is no valid price or percentage.
 */
export function koganFirstPrice(price, percent) {
  const base = Number(price);
  const rate = Number(percent);
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(rate) || rate <= 0) return null;
  const discount = Math.max((base * rate) / 100, KOGAN_FIRST_MIN_AMOUNT, (base * KOGAN_FIRST_MIN_PERCENT) / 100);
  const result = Math.floor((base - discount) * 100 + 1e-6) / 100;
  return result > 0 ? result.toFixed(2) : null;
}

/**
 * How Kogan orders are created in Shopify. "draft" (the default) creates a
 * draft order and completes it as paid, so Shopify gives the order the
 * "Shipping" delivery method that shipping apps such as eShip import.
 * "direct" uses orderCreate, which Shopify marks "Shipping not required".
 */
export const ORDER_METHODS = ["draft", "direct"];

export function orderMethodOf(settings) {
  return settings?.koganOrderMethod === "direct" ? "direct" : "draft";
}

export function hasSyncTag(tags, syncTag) {
  const wanted = syncTag.trim().toLowerCase();
  return (tags || []).some((tag) => tag.trim().toLowerCase() === wanted);
}

/**
 * Remembers Kogan SKUs that Shopify no longer uses. Kogan has no delete
 * endpoint, so their old listings stay in the Kogan catalogue; the import
 * screen hides them and "Import all" skips them so they are not imported back
 * as duplicates.
 */
export async function retireSkus(shop, entries, reason) {
  for (const { sku, title } of entries) {
    if (!sku) continue;
    await prisma.koganRetiredSku.upsert({
      where: { shop_koganSku: { shop, koganSku: sku } },
      create: { shop, koganSku: sku, reason, title: title ?? null },
      update: { reason, title: title ?? undefined },
    });
  }
}

export async function forgetRetiredSkus(shop, skus) {
  if (skus.length === 0) return;
  await prisma.koganRetiredSku.deleteMany({ where: { shop, koganSku: { in: skus } } });
}

export async function getRetiredSkus(shop, skus) {
  const rows = await prisma.koganRetiredSku.findMany({
    where: { shop, ...(skus ? { koganSku: { in: skus } } : {}) },
  });
  return new Map(rows.map((row) => [row.koganSku, row]));
}

export async function logSync(shop, entry) {
  try {
    await prisma.syncLog.create({
      data: {
        shop,
        direction: entry.direction,
        action: entry.action,
        status: entry.status,
        sku: entry.sku ?? null,
        productId: entry.productId ?? null,
        title: entry.title ?? null,
        message: entry.message ? String(entry.message).slice(0, 2000) : null,
        taskId: entry.taskId ? String(entry.taskId).slice(0, 500) : null,
      },
    });
  } catch (error) {
    console.error("Unable to write sync log:", error);
  }
}

export function getRecentLogs(shop, take = 25) {
  return prisma.syncLog.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take,
  });
}

export const LOG_FILTERS = {
  all: {},
  error: { status: "error" },
  shopify_to_kogan: { direction: "shopify_to_kogan" },
  kogan_to_shopify: { direction: "kogan_to_shopify" },
};

/**
 * Deletes activity entries for one shop: specific IDs, everything matching a
 * filter, or everything older than a number of days. Returns how many rows
 * were removed.
 */
export async function deleteLogs(shop, { ids, filter, olderThanDays } = {}) {
  const where = { shop };

  if (Array.isArray(ids)) {
    where.id = { in: ids };
  } else if (olderThanDays) {
    where.createdAt = { lt: new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000) };
  } else {
    Object.assign(where, LOG_FILTERS[filter] || LOG_FILTERS.all);
  }

  const result = await prisma.syncLog.deleteMany({ where });
  return result.count;
}

export async function pruneLogs(shop, keep = 2000) {
  const cutoff = await prisma.syncLog.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    skip: keep,
    take: 1,
    select: { createdAt: true },
  });

  if (cutoff.length > 0) {
    await prisma.syncLog.deleteMany({
      where: { shop, createdAt: { lte: cutoff[0].createdAt } },
    });
  }
}

export function formatKoganErrors(entries) {
  return entries
    .map((entry) => {
      const details = entry.errors || entry.warnings || {};
      const text = Object.entries(details)
        .map(([field, messages]) =>
          `${field}: ${Array.isArray(messages) ? messages.join(", ") : JSON.stringify(messages)}`,
        )
        .join("; ");
      return text || JSON.stringify(details);
    })
    .join(" | ");
}
