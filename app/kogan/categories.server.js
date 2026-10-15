import prisma from "../db.server";
import { createKoganClient, storeCodeForCurrency } from "./kogan-client.server";

const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_AFTER_ERROR_MS = 60 * 60 * 1000;
const INSERT_CHUNK_SIZE = 500;

const runningRefreshes = new Map();

/**
 * Categories differ between Kogan environments (test and production) and
 * stores (Australia and New Zealand), so they are stored per "source".
 */
export function categorySourceFor(settings) {
  const kogan = createKoganClient(settings);
  const storeCode = storeCodeForCurrency(settings.currency);
  return { kogan, storeCode, source: `${new URL(kogan.baseUrl).host}|${storeCode}` };
}

export function getCategorySync(source) {
  return prisma.koganCategorySync.findUnique({ where: { source } });
}

export function isRefreshingCategories(source) {
  return runningRefreshes.has(source);
}

/**
 * Downloads the full Kogan category tree and replaces the stored copy. Only
 * one refresh runs per source at a time; callers share the running one.
 */
export function refreshCategories(settings) {
  const { kogan, storeCode, source } = categorySourceFor(settings);
  if (runningRefreshes.has(source)) return runningRefreshes.get(source);

  const run = (async () => {
    await prisma.koganCategorySync.upsert({
      where: { source },
      create: { source, status: "running" },
      update: { status: "running", error: null },
    });

    const fetched = await kogan.fetchCategoryTree(storeCode);
    const unique = [...new Map(fetched.filter((item) => item.id && item.title).map((item) => [item.id, item])).values()];

    if (unique.length === 0) {
      throw new Error("Kogan returned no categories.");
    }

    const rows = unique.map((item) => ({
      source,
      id: item.id,
      title: item.title,
      slug: item.slug,
      display: item.display,
      departments: JSON.stringify(item.departments),
      url: item.url,
      parentId: item.parentId,
    }));

    await prisma.$transaction(async (tx) => {
      await tx.koganCategory.deleteMany({ where: { source } });
      for (let index = 0; index < rows.length; index += INSERT_CHUNK_SIZE) {
        await tx.koganCategory.createMany({ data: rows.slice(index, index + INSERT_CHUNK_SIZE) });
      }
    }, { timeout: 120000 });

    await prisma.koganCategorySync.update({
      where: { source },
      data: { status: "ok", count: rows.length, syncedAt: new Date(), error: null },
    });

    return rows.length;
  })()
    .catch(async (error) => {
      await prisma.koganCategorySync
        .update({ where: { source }, data: { status: "error", error: error.message.slice(0, 1000) } })
        .catch(() => {});
      throw error;
    })
    .finally(() => runningRefreshes.delete(source));

  runningRefreshes.set(source, run);
  return run;
}

/**
 * Starts a background refresh when the stored categories are missing or older
 * than a week. After a failed refresh it waits an hour before trying again.
 */
export async function ensureCategories(settings) {
  const { source } = categorySourceFor(settings);
  const sync = await getCategorySync(source);
  const age = sync?.syncedAt ? Date.now() - new Date(sync.syncedAt).getTime() : Infinity;
  const recentError =
    sync?.status === "error" && Date.now() - new Date(sync.updatedAt).getTime() < RETRY_AFTER_ERROR_MS;

  if (age > REFRESH_AFTER_MS && !recentError && !runningRefreshes.has(source)) {
    refreshCategories(settings).catch((error) =>
      console.error(`Kogan category refresh failed for ${source}:`, error.message),
    );
  }

  return { source, sync: await getCategorySync(source) };
}

export function presentCategory(category) {
  if (!category) return null;

  let departments = [];
  try {
    departments = JSON.parse(category.departments || "[]");
  } catch {
    departments = [];
  }

  return {
    id: category.id,
    title: category.title,
    display: category.display,
    path: category.display.split("»").map((part) => part.trim()).filter(Boolean),
    departments,
    url: category.url,
    value: `kogan:${category.id}`,
  };
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Understands every way a category can be written: "kogan:46114", "46114",
 * a Kogan slug (with or without the ID at the end), or a category name in any
 * case or as a slug ("12v-appliances").
 */
function parseCategoryValue(raw) {
  const value = String(raw || "").trim();
  if (!value || /^ebay:/i.test(value)) return null;

  const prefixed = value.match(/^kogan:(\d+)$/i);
  if (prefixed) return { id: Number(prefixed[1]) };
  if (/^\d+$/.test(value)) return { id: Number(value) };

  const slugWithId = value.match(/^[a-z0-9-]+-(\d+)$/i);
  if (slugWithId) return { id: Number(slugWithId[1]) };

  return { text: value, slug: slugify(value) };
}

/**
 * Resolves raw category values to stored Kogan categories. Returns a map of
 * raw value -> category (or null when it cannot be matched).
 */
export async function resolveCategoryValues(source, values) {
  const result = new Map();
  const parsed = new Map();

  for (const value of new Set(values.filter(Boolean))) {
    parsed.set(value, parseCategoryValue(value));
    result.set(value, null);
  }

  const ids = [...parsed.values()].filter((item) => item?.id).map((item) => item.id);
  const texts = [...parsed.values()].filter((item) => item?.text);

  if (ids.length > 0) {
    const found = await prisma.koganCategory.findMany({ where: { source, id: { in: ids } } });
    const byId = new Map(found.map((category) => [category.id, category]));
    for (const [value, item] of parsed) {
      if (item?.id) result.set(value, byId.get(item.id) || null);
    }
  }

  if (texts.length > 0) {
    const candidates = await prisma.koganCategory.findMany({
      where: {
        source,
        OR: texts.flatMap((item) => [
          { slug: item.slug },
          { title: { contains: item.text.replace(/-/g, " ") } },
        ]),
      },
      take: 500,
    });

    for (const [value, item] of parsed) {
      if (!item?.text) continue;
      const match =
        candidates.find((category) => category.slug === item.slug) ||
        candidates.find((category) => category.title.toLowerCase() === item.text.toLowerCase()) ||
        candidates.find((category) => slugify(category.title) === item.slug);
      result.set(value, match || null);
    }
  }

  return result;
}

export async function resolveCategoryValue(source, value) {
  return (await resolveCategoryValues(source, [value])).get(value) || null;
}

/**
 * Searches stored categories by name, path or ID. Every word of the query
 * must appear in the category path.
 */
export async function searchCategories(source, { query = "", ids = null, page = 1, pageSize = 25 } = {}) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const numeric = /^(kogan:)?\d+$/i.test(query.trim()) ? Number(query.trim().replace(/^kogan:/i, "")) : null;

  const where = { source };
  if (ids) where.id = { in: ids };
  if (numeric !== null) {
    where.id = ids ? { in: ids.filter((id) => id === numeric) } : numeric;
  } else if (terms.length > 0) {
    where.AND = terms.map((term) => ({ display: { contains: term } }));
  }

  const [total, items] = await Promise.all([
    prisma.koganCategory.count({ where }),
    prisma.koganCategory.findMany({
      where,
      orderBy: [{ title: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, items };
}

/**
 * Counts how many of the shop's products and SKUs sit in each category.
 * Returns the counts per category ID, the values that do not match any
 * Kogan category, and how many SKUs have no category of their own.
 */
export async function categoryUsage(shop, source) {
  const rows = await prisma.koganProductLink.groupBy({
    by: ["koganCategory", "shopifyProductId"],
    where: { shop },
    _count: { _all: true },
  });

  const resolved = await resolveCategoryValues(source, rows.map((row) => row.koganCategory));
  const byCategory = new Map();
  const unknown = new Map();
  let withoutCategory = { products: 0, skus: 0 };

  for (const row of rows) {
    if (!row.koganCategory) {
      withoutCategory = {
        products: withoutCategory.products + 1,
        skus: withoutCategory.skus + row._count._all,
      };
      continue;
    }

    const category = resolved.get(row.koganCategory);
    const target = category ? byCategory : unknown;
    const key = category ? category.id : row.koganCategory;
    const entry = target.get(key) || { products: 0, skus: 0, values: new Set() };
    entry.products += 1;
    entry.skus += row._count._all;
    entry.values.add(row.koganCategory);
    target.set(key, entry);
  }

  return { byCategory, unknown, withoutCategory };
}
