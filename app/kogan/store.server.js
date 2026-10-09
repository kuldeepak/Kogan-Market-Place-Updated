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
  autoSyncEnabled: true,
  createOnKogan: true,
  zeroStockOnDelete: true,
  importAsActive: true,
  autoGenerateSkus: true,
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

export function hasSyncTag(tags, syncTag) {
  const wanted = syncTag.trim().toLowerCase();
  return (tags || []).some((tag) => tag.trim().toLowerCase() === wanted);
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
