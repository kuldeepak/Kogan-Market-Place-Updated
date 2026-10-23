import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { createKoganClient, storeCodeForCurrency } from "./kogan-client.server";
import { categorySourceFor, resolveCategoryValue } from "./categories.server";
import {
  buildSnapshots,
  diffFields,
  imagesKey,
  mapKoganToShopify,
  parseKoganPrice,
  readyImageUrls,
  toMoneyString,
  variantGroupOf,
} from "./mapping.server";
import {
  addTagToProduct,
  addVariantsToProduct,
  assignVariantSkus,
  createShopifyProduct,
  findVariantsBySkus,
  getExistingProductIds,
  getPrimaryLocationId,
  getProductForSync,
  listTaggedProducts,
  updateShopifyProduct,
} from "./shopify-products.server";
import {
  forgetRetiredSkus,
  formatKoganErrors,
  getRetiredSkus,
  getSettings,
  hasSyncTag,
  logSync,
  pruneLogs,
  retireSkus,
} from "./store.server";

const PUSH_DEBOUNCE_MS = 4000;
const CONTENT_FIELDS = [
  "title",
  "description",
  "brand",
  "category",
  "gtin",
  "weight",
  "productType",
  "images",
  "variantGroup",
  "location",
];
const OFFER_FIELDS = ["price", "rrp", "stock", "enabled"];

const activeJobs = new Set();
const pushTimers = new Map();
const pushChains = new Map();
const statusApiForbidden = new Set();

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export async function getLatestJob(shop) {
  const job = await prisma.syncJob.findFirst({
    where: { shop },
    orderBy: { startedAt: "desc" },
  });

  // A job left "running" by a previous server process can never finish.
  if (job?.status === "running" && !activeJobs.has(job.id)) {
    return prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        message: "The sync was interrupted because the app server restarted. Please run it again.",
      },
    });
  }

  return job;
}

async function startJob(shop, type, runner) {
  const running = await getLatestJob(shop);
  if (running?.status === "running") {
    return running;
  }

  const job = await prisma.syncJob.create({ data: { shop, type } });
  activeJobs.add(job.id);

  const counters = { total: 0, processed: 0, created: 0, updated: 0, failed: 0, skipped: 0 };
  let lastFlush = 0;

  const progress = async (force = false) => {
    if (!force && Date.now() - lastFlush < 1000) return;
    lastFlush = Date.now();
    await prisma.syncJob.update({ where: { id: job.id }, data: counters });
  };

  runner(counters, progress)
    .then(async (message) => {
      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          ...counters,
          status: counters.failed > 0 ? "completed_with_errors" : "completed",
          finishedAt: new Date(),
          message: message || null,
        },
      });
    })
    .catch(async (error) => {
      console.error(`${type} job failed for ${shop}:`, error);
      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          ...counters,
          status: "failed",
          finishedAt: new Date(),
          message: error.message,
        },
      });
      await logSync(shop, {
        direction: type === "import" ? "kogan_to_shopify" : "shopify_to_kogan",
        action: type,
        status: "error",
        message: error.message,
      });
    })
    .finally(() => {
      activeJobs.delete(job.id);
      pruneLogs(shop).catch(() => {});
    });

  return job;
}

// ---------------------------------------------------------------------------
// Kogan -> Shopify import
// ---------------------------------------------------------------------------

const IMPORT_CONCURRENCY = 3;

/**
 * Kogan keeps test (UAT) and live listings completely apart and cannot move
 * listings between them, so every link remembers the Kogan API host it was
 * created on.
 */
function hostOf(kogan) {
  return new URL(kogan.baseUrl).host;
}

async function currentKoganHost(shop) {
  try {
    return hostOf(createKoganClient(await getSettings(shop)));
  } catch {
    return null;
  }
}

function categoryOf(fields) {
  const value = typeof fields?.category === "string" ? fields.category.trim() : "";
  return value || null;
}

/**
 * Kogan slugs usually end with the category ID, but not always
 * ("air-tool-parts-accessories"). The stored category tree fills the gap so
 * imported products are saved with a reliable "kogan:ID" value.
 */
async function categoryIdValue(settings, koganProduct, current) {
  if (/^kogan:[0-9]+$/i.test(current || "")) return current;

  try {
    const { source } = categorySourceFor(settings);
    const match =
      (koganProduct.category_slug && (await resolveCategoryValue(source, koganProduct.category_slug))) ||
      (koganProduct.category && (await resolveCategoryValue(source, koganProduct.category)));
    return match ? `kogan:${match.id}` : current;
  } catch {
    return current;
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Works out which SKUs already exist in Shopify. The app's own links are
 * checked first (links to deleted products are cleaned up), then the
 * remaining SKUs are searched in Shopify in batches.
 */
export async function findExistingSkus(admin, shop, skus) {
  const existing = new Map();
  const links = await prisma.koganProductLink.findMany({
    where: { shop, koganSku: { in: skus } },
  });

  if (links.length > 0) {
    const alive = await getExistingProductIds(admin, links.map((link) => link.shopifyProductId));
    const stale = links.filter((link) => !alive.has(link.shopifyProductId));

    for (const link of links) {
      if (alive.has(link.shopifyProductId)) {
        existing.set(link.koganSku, { productId: link.shopifyProductId, linked: true });
      }
    }

    if (stale.length > 0) {
      await prisma.koganProductLink.deleteMany({
        where: { id: { in: stale.map((link) => link.id) } },
      });
    }
  }

  const remaining = skus.filter((sku) => !existing.has(sku));
  if (remaining.length > 0) {
    const found = await findVariantsBySkus(admin, remaining);
    for (const [sku, match] of found) {
      existing.set(sku, { productId: match.productId, linked: false });
    }
  }

  return existing;
}

async function saveLink(admin, shop, productId, sku, mapped, product) {
  const current = product || (await getProductForSync(admin, productId));
  const snapshots = await attachVariantGroups(shop, current, buildSnapshots(current), {
    groupId: mapped.variantGroup?.groupId ?? null,
    facetGroups: Object.fromEntries(
      (mapped.variantGroup?.varyOn || []).map((varyOn) => [varyOn.type, varyOn.group]),
    ),
  });
  const snapshot = snapshots.find((item) => item.sku === sku);
  if (snapshot && mapped.location !== undefined) snapshot.fields.location = mapped.location;

  const linkData = {
    shopifyProductId: productId,
    shopifyVariantId: snapshot?.variantId ?? null,
    inventoryItemId: snapshot?.inventoryItemId ?? null,
    currency: mapped.currency,
    handlingDays: mapped.handlingDays,
    shipping: mapped.shipping,
    koganImagesKey: imagesKey(mapped.images),
    koganStoreUrl: mapped.storeUrl,
    koganGroupId: mapped.variantGroup?.groupId ?? null,
    koganHost: await currentKoganHost(shop),
    snapshot: snapshot ? JSON.stringify(snapshot.fields) : null,
    koganCategory: categoryOf(snapshot?.fields),
    syncStatus: "synced",
    syncError: null,
    lastSyncedAt: new Date(),
    lastDirection: "kogan_to_shopify",
  };

  await prisma.koganProductLink.upsert({
    where: { shop_koganSku: { shop, koganSku: sku } },
    create: { shop, koganSku: sku, ...linkData },
    update: linkData,
  });
  await forgetRetiredSkus(shop, [sku]);
}

function koganPriceTargetFor(product, variant) {
  if (parseKoganPrice(variant?.koganPrice?.value)) return "variant";
  if (parseKoganPrice(product?.koganPrice?.value)) return "product";
  return null;
}

async function refreshExistingProduct(admin, shop, settings, locationId, productId, sku, mapped) {
  const existing = await getProductForSync(admin, productId);
  const link = await prisma.koganProductLink.findUnique({
    where: { shop_koganSku: { shop, koganSku: sku } },
  });
  const variant =
    existing.variants.nodes.find((item) => item.id === link?.shopifyVariantId) ||
    existing.variants.nodes.find((item) => item.sku?.trim() === sku) ||
    existing.variants.nodes[0];

  // A grouped product shares its images between variants, so one variant's
  // Kogan images never replace the whole product gallery.
  const replaceImages =
    !mapped.variantGroup &&
    mapped.images.length > 0 &&
    (link ? imagesKey(mapped.images) !== link.koganImagesKey : existing.media.nodes.length === 0);

  await updateShopifyProduct(admin, {
    productId,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem?.id,
    mapped,
    replaceImages,
    // Status and stock are left alone on paused products so a refresh does
    // not undo a product the merchant deliberately set to draft.
    updateStatus: false,
    updateStock: existing.status === "ACTIVE",
    locationId,
    existing,
    koganPriceTarget: koganPriceTargetFor(existing, variant),
  });

  if (!hasSyncTag(existing.tags, settings.syncTag)) {
    await addTagToProduct(admin, productId, settings.syncTag);
  }

  await saveLink(admin, shop, productId, sku, mapped);
}

async function findGroupProductId(admin, shop, groupId, unitItems, existing) {
  for (const item of unitItems) {
    const match = existing.get(item.sku);
    if (match) return match.productId;
  }

  const links = await prisma.koganProductLink.findMany({
    where: { shop, koganGroupId: groupId },
    select: { shopifyProductId: true },
  });
  if (links.length === 0) return null;

  const alive = await getExistingProductIds(admin, links.map((link) => link.shopifyProductId));
  return links.find((link) => alive.has(link.shopifyProductId))?.shopifyProductId || null;
}

async function logImported(shop, item, productId, message) {
  await logSync(shop, {
    direction: "kogan_to_shopify",
    action: "create",
    status: "success",
    sku: item.sku,
    productId,
    title: item.mapped.title,
    message,
  });
}

/**
 * Imports one unit: either a single Kogan product, or every product of one
 * Kogan variant group found in the batch.
 */
async function importUnit(
  admin,
  shop,
  settings,
  locationId,
  unit,
  existing,
  { updateExisting = false, onlyExisting = false } = {},
  results,
) {
  const fresh = [];

  for (const item of unit.items) {
    const match = existing.get(item.sku);
    if (!match) {
      fresh.push(item);
      continue;
    }

    try {
      if (updateExisting) {
        await refreshExistingProduct(admin, shop, settings, locationId, match.productId, item.sku, item.mapped);
        await logSync(shop, {
          direction: "kogan_to_shopify",
          action: "update",
          status: "success",
          sku: item.sku,
          productId: match.productId,
          title: item.mapped.title,
          message: "Updated in Shopify from Kogan",
        });
        results.set(item.sku, { status: "updated", productId: match.productId, message: "Updated from Kogan" });
        continue;
      }

      if (!match.linked) {
        const product = await getProductForSync(admin, match.productId);
        if (!hasSyncTag(product.tags, settings.syncTag)) {
          await addTagToProduct(admin, match.productId, settings.syncTag);
        }
        await saveLink(admin, shop, match.productId, item.sku, item.mapped);
      }
      results.set(item.sku, {
        status: "exists",
        productId: match.productId,
        message: "A Shopify product with this SKU already exists",
      });
    } catch (error) {
      results.set(item.sku, { status: "failed", productId: null, message: error.message });
    }
  }

  if (fresh.length === 0) return;

  // "Update from Kogan" only refreshes products that are already in Shopify.
  if (onlyExisting) {
    for (const item of fresh) {
      results.set(item.sku, {
        status: "skipped",
        productId: null,
        message: "Not in Shopify, so there is nothing to update",
      });
    }
    return;
  }

  try {
    let productId = null;
    let addedToExisting = false;

    if (unit.groupId) {
      productId = await findGroupProductId(admin, shop, unit.groupId, unit.items, existing);
    }

    if (productId) {
      const product = await getProductForSync(admin, productId);
      await addVariantsToProduct(admin, productId, product, fresh.map((item) => item.mapped), locationId);
      addedToExisting = true;
    } else {
      productId = await createShopifyProduct(admin, fresh.map((item) => item.mapped), locationId);
    }

    const product = await getProductForSync(admin, productId);

    for (const item of fresh) {
      await saveLink(admin, shop, productId, item.sku, item.mapped, product);
      existing.set(item.sku, { productId, linked: true });

      const message = addedToExisting
        ? "Imported as a new variant of an existing Shopify product"
        : item.mapped.listed
          ? "Imported into Shopify"
          : "Imported as a draft (not listed on Kogan)";
      await logImported(shop, item, productId, message);
      results.set(item.sku, { status: "imported", productId, message: "Imported into Shopify" });
    }
  } catch (error) {
    for (const item of fresh) {
      await logSync(shop, {
        direction: "kogan_to_shopify",
        action: "import",
        status: "error",
        sku: item.sku,
        title: item.mapped.title,
        message: error.message,
      });
      results.set(item.sku, { status: "failed", productId: null, message: error.message });
    }
  }
}

/**
 * Imports a batch of Kogan products. Products whose SKU already exists in
 * Shopify are not duplicated: they are reported as "exists" and linked so
 * they keep syncing. With `updateExisting`, existing products are refreshed
 * from Kogan instead. Kogan products in the same variant group become
 * variants of one Shopify product.
 *
 * Returns one result per product: { sku, title, status, productId, message }
 * where status is "imported", "updated", "exists" or "failed".
 */
export async function importKoganProducts(
  admin,
  shop,
  settings,
  locationId,
  koganProducts,
  { updateExisting = false, onlyExisting = false, skipRetired = false } = {},
) {
  const results = new Map();
  const units = [];
  const groups = new Map();

  for (const koganProduct of koganProducts) {
    const sku = koganProduct.product_sku?.trim();
    if (!sku) continue;

    const item = { sku, mapped: mapKoganToShopify(koganProduct, settings) };
    item.mapped.category = await categoryIdValue(settings, koganProduct, item.mapped.category);
    const groupId = item.mapped.variantGroup?.groupId;

    if (groupId) {
      if (!groups.has(groupId)) {
        const unit = { groupId, items: [] };
        groups.set(groupId, unit);
        units.push(unit);
      }
      groups.get(groupId).items.push(item);
    } else {
      units.push({ groupId: null, items: [item] });
    }
  }

  const skus = units.flatMap((unit) => unit.items.map((item) => item.sku));
  const existing = skus.length > 0 ? await findExistingSkus(admin, shop, skus) : new Map();

  if (skipRetired && skus.length > 0) {
    // Old listings of SKUs that were deleted or renamed in Shopify would come
    // back as duplicates, so they are left on Kogan only.
    const retired = await getRetiredSkus(shop, skus);
    for (const unit of units) {
      unit.items = unit.items.filter((item) => {
        if (existing.has(item.sku) || !retired.has(item.sku)) return true;
        results.set(item.sku, {
          status: "skipped",
          productId: null,
          message: "Hidden: this SKU was removed or changed in Shopify",
        });
        return false;
      });
    }
  }

  await mapWithConcurrency(units, IMPORT_CONCURRENCY, (unit) =>
    importUnit(admin, shop, settings, locationId, unit, existing, { updateExisting, onlyExisting }, results),
  );

  return koganProducts.map((koganProduct) => {
    const sku = koganProduct.product_sku?.trim() || "";
    const title = koganProduct.product_title || sku;
    const result = sku
      ? results.get(sku) || { status: "failed", productId: null, message: "Not processed" }
      : { status: "failed", productId: null, message: "The Kogan product has no SKU." };
    return { sku, title, ...result };
  });
}

/**
 * Imports specific SKUs chosen on the import screen.
 */
export async function importSkus(admin, shop, skus, options) {
  const settings = await getSettings(shop);
  const kogan = createKoganClient(settings);
  const locationId = await getPrimaryLocationId(admin, shop);

  const koganProducts = (
    await Promise.all(skus.map((sku) => kogan.getProductBySku(sku)))
  ).filter(Boolean);

  const results = await importKoganProducts(admin, shop, settings, locationId, koganProducts, options);
  const returned = new Set(results.map((item) => item.sku));

  for (const sku of skus) {
    if (!returned.has(sku)) {
      results.push({ sku, title: sku, status: "failed", productId: null, message: "Not found on Kogan" });
    }
  }

  return results;
}

/**
 * Imports the whole Kogan catalogue in the background, page by page, so it
 * scales to tens of thousands of products.
 */
export function startImportJob(shop) {
  return startJob(shop, "import", async (counters, progress) => {
    const { admin } = await unauthenticated.admin(shop);
    const settings = await getSettings(shop);
    const kogan = createKoganClient(settings);
    const locationId = await getPrimaryLocationId(admin, shop);
    let hidden = 0;

    for await (const page of kogan.listProducts({ pageSize: 100 })) {
      counters.total += page.length;
      await progress(true);

      const results = await importKoganProducts(admin, shop, settings, locationId, page, {
        skipRetired: true,
      });

      for (const result of results) {
        if (result.status === "imported") counters.created += 1;
        else if (result.status === "exists") counters.skipped += 1;
        else if (result.status === "skipped") hidden += 1;
        else if (result.status === "failed") counters.failed += 1;
        counters.processed += 1;
      }

      await progress(true);
    }

    const hiddenNote = hidden > 0
      ? ` ${hidden} old Kogan listings of SKUs removed or changed in Shopify were not imported.`
      : "";
    return `Imported ${counters.created} new products. ${counters.skipped} already existed in Shopify and were skipped.${hiddenNote}`;
  });
}

/**
 * "Update all from Kogan": reads the whole Kogan catalogue, page by page, and
 * refreshes every product that is already in Shopify with Kogan's data and
 * store link. Products that are only on Kogan are left alone.
 */
export function startRefreshJob(shop) {
  return startJob(shop, "refresh", async (counters, progress) => {
    const { admin } = await unauthenticated.admin(shop);
    const settings = await getSettings(shop);
    const kogan = createKoganClient(settings);
    const locationId = await getPrimaryLocationId(admin, shop);

    for await (const page of kogan.listProducts({ pageSize: 100 })) {
      counters.total += page.length;
      await progress(true);

      const results = await importKoganProducts(admin, shop, settings, locationId, page, {
        updateExisting: true,
        onlyExisting: true,
      });

      for (const result of results) {
        if (result.status === "updated") counters.updated += 1;
        else if (result.status === "failed") counters.failed += 1;
        else counters.skipped += 1;
        counters.processed += 1;
      }

      await progress(true);
    }

    return `Updated ${counters.updated} Shopify products from Kogan. ${counters.skipped} Kogan products are not in Shopify and were left alone.`;
  });
}

// ---------------------------------------------------------------------------
// Shopify -> Kogan push
// ---------------------------------------------------------------------------

/**
 * Debounces pushes per product: Shopify often sends several webhooks for one
 * save (product update, inventory update), and they are collapsed into a
 * single run. Runs for the same product never overlap.
 */
export function schedulePush(shop, productId, reason = "webhook") {
  const key = `${shop}|${productId}`;
  clearTimeout(pushTimers.get(key));

  pushTimers.set(
    key,
    setTimeout(() => {
      pushTimers.delete(key);
      const previous = pushChains.get(key) || Promise.resolve();
      const next = previous
        .then(async () => {
          const { admin } = await unauthenticated.admin(shop);
          await pushProductToKogan(admin, shop, productId, { reason });
        })
        .catch((error) => console.error(`Kogan push failed for ${productId}:`, error))
        .finally(() => {
          if (pushChains.get(key) === next) pushChains.delete(key);
        });
      pushChains.set(key, next);
    }, PUSH_DEBOUNCE_MS),
  );
}

function emptyResult() {
  return { created: 0, updated: 0, failed: 0, unchanged: 0, skipped: 0 };
}

const MAX_SKU_LENGTH = 45;
const missingSkuWarnings = new Set();

function skuPart(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Kogan needs a SKU for every variant. Variants added in Shopify often have
 * none, so a SKU is built from an existing SKU of the product (or its handle)
 * and the variant's option values, made unique, and saved back to Shopify.
 */
async function ensureVariantSkus(admin, shop, settings, product) {
  const variants = product.variants?.nodes || [];
  const missing = variants.filter((variant) => !variant.sku?.trim());
  if (missing.length === 0) return product;

  if (!settings.autoGenerateSkus) {
    for (const variant of missing) {
      if (missingSkuWarnings.has(variant.id)) continue;
      missingSkuWarnings.add(variant.id);
      await logSync(shop, {
        direction: "shopify_to_kogan",
        action: "create",
        status: "error",
        productId: product.id,
        title: `${product.title} - ${variant.title}`,
        message: "This variant has no SKU, so it cannot be listed on Kogan. Add a SKU in Shopify.",
      });
    }
    return product;
  }

  const base =
    skuPart(variants.find((variant) => variant.sku?.trim())?.sku) ||
    skuPart(product.handle || product.title) ||
    "SKU";

  const candidates = missing.map((variant) => {
    const options = (variant.selectedOptions || [])
      .filter((option) => option.name !== "Title")
      .map((option) => skuPart(option.value))
      .filter(Boolean);
    const suffix = options.length > 0 ? options.join("-") : skuPart(variant.id.split("/").pop());
    const room = MAX_SKU_LENGTH - suffix.length - 1;
    return { variant, sku: room > 3 ? `${base.slice(0, room)}-${suffix}` : suffix.slice(0, MAX_SKU_LENGTH) };
  });

  // Make every SKU unique within the product and across the shop.
  const taken = new Set(variants.map((variant) => variant.sku?.trim()).filter(Boolean));
  const elsewhere = await findVariantsBySkus(admin, candidates.map((item) => item.sku));
  for (const sku of elsewhere.keys()) taken.add(sku);

  const assignments = candidates.map(({ variant, sku }) => {
    let unique = sku;
    for (let counter = 2; taken.has(unique); counter++) {
      const tail = `-${counter}`;
      unique = `${sku.slice(0, MAX_SKU_LENGTH - tail.length)}${tail}`;
    }
    taken.add(unique);
    return { variantId: variant.id, sku: unique, title: variant.title };
  });

  await assignVariantSkus(admin, product.id, assignments);

  for (const assignment of assignments) {
    await logSync(shop, {
      direction: "shopify_to_kogan",
      action: "update",
      status: "success",
      sku: assignment.sku,
      productId: product.id,
      title: `${product.title} - ${assignment.title}`,
      message: `The variant had no SKU, so ${assignment.sku} was created for it in Shopify.`,
    });
  }

  return getProductForSync(admin, product.id);
}

/**
 * Adds Kogan variant group information to the snapshots of a product with
 * options. All variants share one group ID: the Kogan group the product was
 * imported from, or one based on the Shopify product ID. Each option keeps
 * the Kogan facet group it belongs to, so products imported from Kogan are
 * sent back with Kogan's own facet groups.
 *
 * `known` can pass the group ID and facet groups of a Kogan variant group
 * that is being imported: { groupId, facetGroups: { optionName: group } }.
 */
export async function attachVariantGroups(shop, product, snapshots, known = {}) {
  const grouped =
    (product.variants?.nodes?.length || 0) > 1 &&
    snapshots.some((item) => item.options?.length > 0);

  if (!grouped) {
    for (const snapshot of snapshots) snapshot.fields.variantGroup = null;
    return snapshots;
  }

  const links = await prisma.koganProductLink.findMany({
    where: { shop, koganSku: { in: snapshots.map((item) => item.sku) } },
    select: { koganGroupId: true, snapshot: true },
  });
  const groupId =
    links.find((link) => link.koganGroupId)?.koganGroupId ||
    known.groupId ||
    `SHOPIFY-${product.id.split("/").pop()}`;

  const facetGroups = { ...(known.facetGroups || {}) };
  for (const link of links) {
    let previous = null;
    try {
      previous = link.snapshot ? JSON.parse(link.snapshot).variantGroup : null;
    } catch {
      previous = null;
    }
    for (const option of previous?.options || []) {
      if (option.group && !facetGroups[option.name]) facetGroups[option.name] = option.group;
    }
  }

  for (const snapshot of snapshots) {
    snapshot.fields.variantGroup = {
      groupId,
      title: product.title.slice(0, 255),
      options: (snapshot.options || []).slice(0, 3).map(({ name, value }) => ({
        name,
        value,
        group: facetGroups[name] || koganFacetGroupFor(name),
      })),
    };
  }

  return snapshots;
}

/**
 * Takes variants that were deleted in Shopify (or lost their SKU) off sale on
 * Kogan, so a removed variant can no longer be ordered there.
 */
async function removeDeletedVariants(kogan, shop, settings, product, currentSkus) {
  const stale = await prisma.koganProductLink.findMany({
    where: { shop, shopifyProductId: product.id, koganSku: { notIn: currentSkus } },
  });

  for (const link of stale) {
    const title = link.snapshot ? JSON.parse(link.snapshot).title : product.title;

    if (settings.zeroStockOnDelete) {
      try {
        await removeFromKogan(kogan, shop, link);
        await logSync(shop, {
          direction: "shopify_to_kogan",
          action: "delete",
          status: "success",
          sku: link.koganSku,
          productId: product.id,
          title,
          message: "The variant was removed in Shopify, so it was removed from sale on Kogan.",
        });
      } catch (error) {
        await logSync(shop, {
          direction: "shopify_to_kogan",
          action: "delete",
          status: "error",
          sku: link.koganSku,
          productId: product.id,
          title,
          message: error.message,
        });
        continue;
      }
    }

    await prisma.koganProductLink.delete({ where: { id: link.id } });
    await retireSkus(shop, [{ sku: link.koganSku, title }], "removed");
  }
}

/**
 * Pushes the current state of a Shopify product to Kogan. Only fields that
 * changed since the last successful sync are sent. Every variant is its own
 * Kogan product (one per SKU), linked together as a Kogan variant group.
 */
export async function pushProductToKogan(admin, shop, productId, { reason = "webhook", product: given } = {}) {
  const result = emptyResult();
  const settings = await getSettings(shop);

  if (reason === "webhook" && !settings.autoSyncEnabled) {
    result.skipped += 1;
    return result;
  }

  let product = given || (await getProductForSync(admin, productId));
  if (!product || !hasSyncTag(product.tags, settings.syncTag)) {
    result.skipped += 1;
    return result;
  }

  product = await ensureVariantSkus(admin, shop, settings, product);

  const allSnapshots = buildSnapshots(product);
  const seen = new Set();
  const snapshots = [];

  for (const snapshot of allSnapshots) {
    if (seen.has(snapshot.sku)) {
      result.failed += 1;
      await logSync(shop, {
        direction: "shopify_to_kogan",
        action: "update",
        status: "error",
        sku: snapshot.sku,
        productId: product.id,
        title: snapshot.fields.title,
        message: "Two variants of this product use the same SKU. Kogan needs a different SKU for each variant.",
      });
      continue;
    }
    seen.add(snapshot.sku);
    snapshots.push(snapshot);
  }

  const kogan = createKoganClient(settings);
  await removeDeletedVariants(kogan, shop, settings, product, snapshots.map((item) => item.sku));

  if (snapshots.length === 0) {
    result.skipped += 1;
    if (reason !== "webhook") {
      await logSync(shop, {
        direction: "shopify_to_kogan",
        action: "update",
        status: "error",
        productId: product.id,
        title: product.title,
        message: "This product has no SKU. Add a SKU to the variant so it can sync with Kogan.",
      });
    }
    return result;
  }

  await attachVariantGroups(shop, product, snapshots);

  // The stock location is managed from Settings. Kogan uses it for tax: for
  // Kogan New Zealand, stock that is not located in NZ gets 15% GST added.
  if (settings.productLocation) {
    for (const snapshot of snapshots) snapshot.fields.location = settings.productLocation;
  }

  const links = await prisma.koganProductLink.findMany({
    where: { shop, koganSku: { in: snapshots.map((item) => item.sku) } },
  });

  for (const snapshot of snapshots) {
    let link = links.find((item) => item.koganSku === snapshot.sku);
    let relisting = reason === "relist";

    try {
      if (link && link.koganHost && link.koganHost !== hostOf(kogan)) {
        // Listed on another Kogan environment (for example the test one):
        // Kogan cannot update it here, it has to be created again.
        await prisma.koganProductLink.deleteMany({ where: { id: link.id } });
        await logSync(shop, {
          direction: "shopify_to_kogan",
          action: "create",
          status: "success",
          sku: snapshot.sku,
          productId: product.id,
          title: snapshot.fields.title,
          message: `This SKU was listed on ${link.koganHost}, but the app now uses ${hostOf(kogan)}. Kogan does not copy listings between environments, so the app is creating it ${RELIST_NOTE}.`,
        });
        link = undefined;
        relisting = true;
      }

      if (link && link.shopifyProductId !== product.id) {
        // The SKU was moved to another Shopify product; follow it.
        link = await prisma.koganProductLink.update({
          where: { id: link.id },
          data: { shopifyProductId: product.id, shopifyVariantId: snapshot.variantId },
        });
      }

      if (!link) {
        const adopted = await adoptExistingKoganProduct(kogan, shop, settings, product, snapshot);
        if (adopted) {
          link = adopted;
        } else if (settings.createOnKogan || relisting) {
          const created = await createOnKogan(kogan, shop, settings, product, snapshot);
          result[created ? "created" : "failed"] += 1;
          continue;
        } else {
          result.skipped += 1;
          continue;
        }
      }

      const outcome = await pushChanges(kogan, shop, product, snapshot, link, reason);
      result[outcome] += 1;
    } catch (error) {
      result.failed += 1;
      await recordFailure(shop, link, product, snapshot.sku, "update", error.message);
    }
  }

  return result;
}

async function adoptExistingKoganProduct(kogan, shop, settings, product, snapshot) {
  const koganProduct = await kogan.getProductBySku(snapshot.sku);
  if (!koganProduct) return null;

  const mapped = mapKoganToShopify(koganProduct, settings);
  await forgetRetiredSkus(shop, [snapshot.sku]);

  // The previous snapshot is unknown, so it is left empty and every field is
  // treated as changed: Shopify becomes the source of truth for this product.
  return prisma.koganProductLink.create({
    data: {
      shop,
      koganSku: snapshot.sku,
      shopifyProductId: product.id,
      shopifyVariantId: snapshot.variantId,
      inventoryItemId: snapshot.inventoryItemId,
      currency: mapped.currency,
      handlingDays: mapped.handlingDays,
      shipping: mapped.shipping,
      koganImagesKey: imagesKey(mapped.images),
      koganStoreUrl: mapped.storeUrl,
      koganHost: hostOf(kogan),
      koganGroupId: mapped.variantGroup?.groupId ?? null,
      snapshot: null,
      syncStatus: "pending",
      lastDirection: "shopify_to_kogan",
    },
  });
}

function buildOfferData(link, fields) {
  const offer = {
    price: fields.price,
    handling_days: link.handlingDays,
  };
  if (fields.rrp && Number(fields.rrp) > Number(fields.price)) offer.rrp = fields.rrp;
  if (link.shipping !== null && link.shipping !== undefined) offer.shipping = link.shipping;
  return { [link.currency]: offer };
}

function effectiveStock(fields) {
  if (fields.stock === null) return null;
  return fields.enabled ? fields.stock : 0;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Turns whatever the merchant typed into a category Kogan accepts:
 * "kogan:46114", a Kogan category URL slug ending in its ID, a bare ID, or a
 * category name written in any case or as a slug ("12v-appliances").
 */
async function resolveCategory(kogan, currency, value) {
  const raw = (value || "").trim();
  if (!raw) return raw;
  if (/^(kogan|ebay):\d+$/i.test(raw)) return raw.toLowerCase();
  if (/^\d+$/.test(raw)) return `kogan:${raw}`;

  const slugId = raw.match(/^[a-z0-9-]+-(\d+)$/i);
  if (slugId) return `kogan:${slugId[1]}`;

  const stored = await resolveCategoryValue(
    `${new URL(kogan.baseUrl).host}|${storeCodeForCurrency(currency)}`,
    raw,
  ).catch(() => null);
  if (stored) return `kogan:${stored.id}`;

  try {
    const categories = await kogan.getAllCategories(storeCodeForCurrency(currency));
    const wanted = slugify(raw);
    const match =
      categories.find((category) => category.title.toLowerCase() === raw.toLowerCase()) ||
      categories.find((category) => slugify(category.title) === wanted);
    // Kogan turns category names into slugs and then fails to find them
    // ("12V Appliances" -> "12v-appliances"), so only IDs are reliable.
    if (match) return `kogan:${match.id}`;
  } catch {
    // The category list is only a convenience; Kogan validates the raw value.
  }

  return raw;
}

function withCategoryHint(problems) {
  return problems.map((problem) =>
    /category/i.test(problem)
      ? `${problem}. Set the "Kogan category" metafield to a value like kogan:46114, or choose a default category in Settings.`
      : problem,
  );
}

// Kogan only accepts facet group names from its own list, and rejects names
// such as "Size", "Colour" or "Product Options". Tested against Kogan:
// "General" and "Storage" are accepted, and the Shopify option name (Colour,
// Size, ...) is accepted as the facet type inside the group.
const KOGAN_FACET_GROUPS = {
  storage: "Storage",
  "internal storage": "Storage",
  capacity: "Storage",
  memory: "Storage",
};
const DEFAULT_KOGAN_FACET_GROUP = "General";

function koganFacetGroupFor(optionName) {
  return KOGAN_FACET_GROUPS[String(optionName).trim().toLowerCase()] || DEFAULT_KOGAN_FACET_GROUP;
}

// Kogan's own API example uses the "Internal Storage" facet type inside the
// "Storage" group, so a plain "Storage" option is sent with that name.
function koganFacetTypeFor(option, group) {
  const name = String(option.name).trim();
  return group === "Storage" && name.toLowerCase() === "storage" ? "Internal Storage" : name;
}

/**
 * Converts the app's variant group description into Kogan's format. Each
 * Shopify option becomes a Kogan facet: the facet type is the option name and
 * the facet group is a Kogan group name. The variants vary on those facets.
 */
function koganVariantPayload(group) {
  if (!group?.options?.length) return null;

  const varyOn = group.options.map((option) => {
    const facetGroup = (option.group || koganFacetGroupFor(option.name)).slice(0, 255);
    return { group: facetGroup, type: koganFacetTypeFor(option, facetGroup).slice(0, 255) };
  });

  return {
    variant: {
      group_id: group.groupId.slice(0, 255),
      group_title: (group.title || "Variants").slice(0, 255),
      vary_on: varyOn[0],
      ...(varyOn[1] ? { vary_on_2: varyOn[1] } : {}),
      ...(varyOn[2] ? { vary_on_3: varyOn[2] } : {}),
    },
    facets: Object.values(
      group.options.reduce((facets, option, index) => {
        const name = varyOn[index].group;
        facets[name] ??= { group: name, items: [] };
        facets[name].items.push({ type: varyOn[index].type, value: String(option.value).slice(0, 255) });
        return facets;
      }, {}),
    ),
  };
}

function isVariantProblem(problem) {
  return /variant|facet|vary/i.test(problem);
}

function collectWarnings(response, sku = null) {
  const warnings = (response.warnings || []).filter((entry) => !sku || entry.product_sku === sku);
  return warnings.length ? [formatKoganErrors(warnings)] : [];
}

async function logVariantRejection(shop, product, sku, problems) {
  await logSync(shop, {
    direction: "shopify_to_kogan",
    action: "update",
    status: "error",
    sku,
    productId: product.id,
    title: product.title,
    message: `Kogan did not accept the variant grouping, so this SKU is listed on its own: ${problems.join(" | ")}`,
  });
}

async function pushChanges(kogan, shop, product, snapshot, link, reason) {
  const previous = link.snapshot ? JSON.parse(link.snapshot) : null;
  const next = { ...snapshot.fields };
  let changed = diffFields(previous, next);

  // Products that were linked before variant groups existed still need their
  // group sent once.
  for (const field of ["variantGroup", "location"]) {
    if (previous && !(field in previous) && next[field] && !changed.includes(field)) {
      changed.push(field);
    }
  }

  let imageUrls = null;
  if (changed.includes("images")) {
    imageUrls = readyImageUrls(product, next.images);
    if (!imageUrls) {
      // Shopify is still processing new media; keep the old value so the
      // images are pushed by the webhook that fires once processing finishes.
      next.images = previous?.images ?? [];
      changed = changed.filter((field) => field !== "images");
    }
  }

  if (changed.length === 0) {
    if (reason !== "webhook" && link.syncStatus === "error") {
      await markSynced(shop, link, snapshot, next);
    }
    return "unchanged";
  }

  const contentChanges = changed.filter((field) => CONTENT_FIELDS.includes(field));
  const offerChanges = changed.filter((field) => OFFER_FIELDS.includes(field));
  const problems = [];
  const warnings = [];
  const pendingUrls = [];

  const taskIds = [];
  const track = (response, { categoryHint = false } = {}) => {
    const found = collectProblems(response);
    problems.push(...(categoryHint ? withCategoryHint(found) : found));
    warnings.push(...collectWarnings(response));
    pendingUrls.push(...(response.pendingUrls || []));
    taskIds.push(...(response.taskIds || []));
  };

  if (contentChanges.length > 0) {
    const payload = { product_sku: snapshot.sku };
    if (contentChanges.includes("title")) payload.product_title = next.title.slice(0, 255);
    if (contentChanges.includes("description")) payload.product_description = next.description || next.title;
    if (contentChanges.includes("brand") && next.brand) payload.brand = next.brand;
    if (contentChanges.includes("category")) {
      // A product without its own category uses the default from Settings.
      const categoryValue = next.category || (await getSettings(shop)).defaultCategory;
      if (categoryValue) payload.category = await resolveCategory(kogan, link.currency, categoryValue);
    }
    if (contentChanges.includes("gtin") && next.gtin) payload.product_gtin = next.gtin.slice(0, 14);
    if (contentChanges.includes("weight") && next.weight > 0) {
      payload.product_dimensions = { weight: next.weight };
    }
    if (contentChanges.includes("productType")) payload.product_type = next.productType;
    if (contentChanges.includes("location") && next.location) payload.product_location = next.location;
    if (contentChanges.includes("images") && imageUrls?.length) payload.images = imageUrls;

    const grouping = contentChanges.includes("variantGroup") ? koganVariantPayload(next.variantGroup) : null;

    if (grouping || Object.keys(payload).length > 1) {
      const response = await kogan.updateProducts([grouping ? { ...payload, ...grouping } : payload]);
      const found = collectProblems(response);

      if (grouping && found.length > 0 && found.every(isVariantProblem)) {
        // The rest of the update still goes through without the grouping.
        await logVariantRejection(shop, product, snapshot.sku, found);
        if (Object.keys(payload).length > 1) track(await kogan.updateProducts([payload]), { categoryHint: true });
      } else {
        track(response, { categoryHint: true });
      }
    }
  }

  if (offerChanges.length > 0) {
    if (offerChanges.includes("enabled") && !statusApiForbidden.has(shop)) {
      try {
        track(
          await kogan.updateEnabledStatus([{ product_sku: snapshot.sku, enabled: next.enabled }]),
        );
      } catch (error) {
        if (error.status === 403) {
          // Without Kogan's enable/disable permission, a paused product is
          // taken off sale by setting its Kogan stock to zero instead.
          statusApiForbidden.add(shop);
        } else {
          problems.push(error.message);
        }
      }
    }

    const payload = { product_sku: snapshot.sku };
    const stock = effectiveStock(next);
    if (stock !== null && (offerChanges.includes("stock") || offerChanges.includes("enabled"))) {
      payload.stock = stock;
    }
    if ((offerChanges.includes("price") || offerChanges.includes("rrp")) && next.price) {
      payload.offer_data = buildOfferData(link, next);
    }

    if (Object.keys(payload).length > 1) {
      track(await kogan.updateStockAndPrice([payload]));
    }
  }

  if (problems.length > 0) {
    if (problems.some(isNotFoundProblem)) {
      return handleMissingOnKogan(kogan, shop, product, snapshot, link, problems, taskIds);
    }
    await recordFailure(shop, link, product, snapshot.sku, "update", problems.join(" | "), taskIds);
    return "failed";
  }

  await markSynced(shop, link, snapshot, next, pendingUrls, taskIds);

  const labels = changed.map((field) => (field === "variantGroup" ? "variants" : field));
  const notes = [];
  if (pendingUrls.length > 0) notes.push("Kogan is still processing this update; the result is checked automatically.");
  if (warnings.length > 0) notes.push(`Kogan skipped some data: ${warnings.join(" | ")}`);

  await logSync(shop, {
    direction: "shopify_to_kogan",
    action: "update",
    status: "success",
    sku: snapshot.sku,
    productId: product.id,
    title: product.title,
    message: [
      `Sent to Kogan: ${labels.join(", ")}. Kogan accepted it; the app confirms the result on Kogan in about 10 minutes`,
      ...notes,
    ].join(". "),
    taskId: taskIds.join(", "),
  });

  return "updated";
}

const RELIST_NOTE = "with a new listing (Product Create / POST)";
const MAX_RELISTS_PER_DAY = 2;

function missingSkuMessage(sku) {
  return `SKU ${sku} does not exist in this Kogan account, so it cannot be updated. Kogan only updates products that were created in the same environment (products listed on Kogan's test environment must be listed again on the live one). The app is creating it ${RELIST_NOTE}.`;
}

function relistLimitMessage(sku, problems) {
  return `Kogan still reports SKU ${sku} as not found (${problems.join(" | ")}), although the app created it again ${MAX_RELISTS_PER_DAY} times in the last 24 hours. Send the Kogan task ID to Kogan support.`;
}

/**
 * Stops a product from being created again and again when Kogan keeps
 * rejecting it, for example while a new listing waits for Kogan's approval.
 */
async function relistLimitReached(shop, sku) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const count = await prisma.syncLog.count({
    where: { shop, sku, message: { contains: RELIST_NOTE }, createdAt: { gte: since } },
  });
  return count >= MAX_RELISTS_PER_DAY;
}

/**
 * Used when Kogan reports a linked SKU as not found outside a push (a task
 * that finished late, the stock location job, or the verification step).
 * When Kogan really has no such SKU, the link is removed and the product is
 * pushed again, which creates it with Product Create (POST).
 */
async function relistMissingSku(kogan, shop, link, problems, taskIds = []) {
  const taskId = taskIds.filter(Boolean).join(", ") || link.lastTaskId || null;
  let title = null;
  try {
    title = link.snapshot ? JSON.parse(link.snapshot).title : null;
  } catch {
    title = null;
  }

  const fail = async (message) => {
    await prisma.koganProductLink.updateMany({
      where: { id: link.id },
      data: { syncStatus: "error", syncError: message.slice(0, 2000), verifyAfter: null, pendingTaskUrl: null },
    });
    await logSync(shop, {
      direction: "shopify_to_kogan",
      action: "update",
      status: "error",
      sku: link.koganSku,
      productId: link.shopifyProductId,
      title,
      message,
      taskId,
    });
    return false;
  };

  if (await relistLimitReached(shop, link.koganSku)) {
    return fail(relistLimitMessage(link.koganSku, problems));
  }

  let listed;
  try {
    listed = await kogan.getProductBySku(link.koganSku);
  } catch (error) {
    return fail(`${problems.join(" | ")}. The app could not check whether the SKU exists on Kogan: ${error.message}`);
  }

  if (listed) {
    return fail(
      `Kogan lists SKU ${link.koganSku}, but its update service cannot find it (${problems.join(" | ")}). This can only be fixed by Kogan: send them the Kogan task ID.`,
    );
  }

  await prisma.koganProductLink.deleteMany({ where: { id: link.id } });
  await logSync(shop, {
    direction: "shopify_to_kogan",
    action: "create",
    status: "success",
    sku: link.koganSku,
    productId: link.shopifyProductId,
    title,
    message: missingSkuMessage(link.koganSku),
    taskId,
  });
  schedulePush(shop, link.shopifyProductId, "relist");
  return true;
}

function isNotFoundProblem(problem) {
  return /not found|does not exist/i.test(problem) && !/category/i.test(problem);
}

/**
 * Kogan answered that the SKU does not exist. The app asks Kogan directly:
 * when the SKU really is not in this Kogan account (for example it was
 * created on Kogan's test environment, or never finished being created), it
 * is listed again. When Kogan does list the SKU but still cannot update it,
 * the problem is on Kogan's side and the task ID is shown for Kogan support.
 */
async function handleMissingOnKogan(kogan, shop, product, snapshot, link, problems, taskIds) {
  let listed;
  try {
    listed = await kogan.getProductBySku(snapshot.sku);
  } catch (error) {
    await recordFailure(
      shop,
      link,
      product,
      snapshot.sku,
      "update",
      `${problems.join(" | ")}. The app could not check whether the SKU exists on Kogan: ${error.message}`,
      taskIds,
    );
    return "failed";
  }

  if (!listed) {
    if (await relistLimitReached(shop, snapshot.sku)) {
      await recordFailure(shop, link, product, snapshot.sku, "update", relistLimitMessage(snapshot.sku, problems), taskIds);
      return "failed";
    }

    // deleteMany: a parallel sync of the same product may have removed it already.
    await prisma.koganProductLink.deleteMany({ where: { id: link.id } });
    await logSync(shop, {
      direction: "shopify_to_kogan",
      action: "create",
      status: "success",
      sku: snapshot.sku,
      productId: product.id,
      title: product.title,
      message: missingSkuMessage(snapshot.sku),
      taskId: taskIds.join(", "),
    });
    const created = await createOnKogan(kogan, shop, await getSettings(shop), product, snapshot);
    return created ? "created" : "failed";
  }

  await recordFailure(
    shop,
    link,
    product,
    snapshot.sku,
    "update",
    `Kogan lists SKU ${snapshot.sku}, but its update service cannot find it (${problems.join(" | ")}). This can only be fixed by Kogan: send them the Kogan task ID.`,
    taskIds,
  );
  return "failed";
}

/**
 * With `sku`, only the errors of that SKU are returned. One Kogan task can
 * cover up to 500 SKUs, and another SKU's error must not be shown on this one.
 */
function collectProblems(response, sku = null) {
  const problems = [];
  const errors = (response.errors || []).filter((entry) => !sku || entry.product_sku === sku);
  if (response.error) problems.push(response.error);
  if (errors.length > 0) problems.push(formatKoganErrors(errors));
  if (response.status === "Failed" && problems.length === 0) {
    problems.push("Kogan rejected the update.");
  }
  return problems;
}

async function createOnKogan(kogan, shop, settings, product, snapshot) {
  const fields = snapshot.fields;
  const rawCategory = fields.category || settings.defaultCategory;
  const images = readyImageUrls(product, fields.images);
  const missing = [];

  if (!rawCategory) missing.push("a Kogan category (product metafield \"Kogan category\" or the default category in Settings)");
  if (!fields.price || Number(fields.price) <= 0) missing.push("a price");
  if (!images || images.length === 0) missing.push("at least one image");

  if (missing.length > 0) {
    await logSync(shop, {
      direction: "shopify_to_kogan",
      action: "create",
      status: "error",
      sku: snapshot.sku,
      productId: product.id,
      title: fields.title,
      message: `Cannot create this product on Kogan yet. It needs ${missing.join(", ")}.`,
    });
    return false;
  }

  const offer = { price: fields.price, handling_days: settings.handlingDays };
  if (fields.rrp && Number(fields.rrp) > Number(fields.price)) offer.rrp = fields.rrp;

  const payload = {
    product_sku: snapshot.sku,
    product_title: fields.title.slice(0, 255),
    product_description: fields.description || fields.title,
    category: await resolveCategory(kogan, settings.currency, rawCategory),
    images,
    stock: effectiveStock(fields) ?? 0,
    product_condition: "new",
    product_type: fields.productType || "Physical",
    offer_data: { [settings.currency]: offer },
  };
  if (fields.brand) payload.brand = fields.brand;
  if (fields.gtin) payload.product_gtin = fields.gtin.slice(0, 14);
  if (fields.weight > 0) payload.product_dimensions = { weight: fields.weight };
  if (settings.productLocation) payload.product_location = settings.productLocation;

  const grouping = koganVariantPayload(fields.variantGroup);
  let response = await kogan.createProducts([grouping ? { ...payload, ...grouping } : payload]);
  let problems = collectProblems(response);
  const taskIds = [...(response.taskIds || [])];
  let grouped = Boolean(grouping);

  // When Kogan refuses only the grouping, the variant is still listed on its
  // own rather than not at all, and the reason is shown in the activity log.
  if (grouping && problems.length > 0 && problems.every(isVariantProblem)) {
    await logVariantRejection(shop, product, snapshot.sku, problems);
    response = await kogan.createProducts([payload]);
    problems = collectProblems(response);
    taskIds.push(...(response.taskIds || []));
    grouped = false;
  }

  if (problems.length > 0) {
    await logSync(shop, {
      direction: "shopify_to_kogan",
      action: "create",
      status: "error",
      sku: snapshot.sku,
      productId: product.id,
      title: fields.title,
      message: withCategoryHint(problems).join(" | "),
      taskId: taskIds.join(", "),
    });
    return false;
  }

  const pendingUrls = response.pendingUrls || [];
  const warnings = collectWarnings(response);

  const linkData = {
    shopifyProductId: product.id,
    shopifyVariantId: snapshot.variantId,
    inventoryItemId: snapshot.inventoryItemId,
    currency: settings.currency,
    handlingDays: settings.handlingDays,
    koganGroupId: grouped ? fields.variantGroup.groupId : null,
    snapshot: JSON.stringify(grouped ? fields : { ...fields, variantGroup: null }),
    koganCategory: categoryOf(fields),
    syncStatus: "pending",
    pendingTaskUrl: pendingUrls.length > 0 ? JSON.stringify(pendingUrls) : null,
    verifyAfter: nextVerifyTime(),
    lastTaskId: taskIds.at(-1) || null,
    koganHost: hostOf(kogan),
    syncError: null,
    verifyAttempts: 0,
    lastSyncedAt: new Date(),
    lastDirection: "shopify_to_kogan",
  };

  // upsert: a parallel sync of the same product may have created the link.
  await prisma.koganProductLink.upsert({
    where: { shop_koganSku: { shop, koganSku: snapshot.sku } },
    create: { shop, koganSku: snapshot.sku, ...linkData },
    update: linkData,
  });
  await forgetRetiredSkus(shop, [snapshot.sku]);

  const base = grouped
    ? "Sent to Kogan as a new listing (a variant of the product). The app confirms it on Kogan in about 10 minutes"
    : "Sent to Kogan as a new listing. The app confirms it on Kogan in about 10 minutes";
  const notes = [];
  if (pendingUrls.length > 0) notes.push("Kogan is still processing the new listing; the result is checked automatically.");
  if (warnings.length > 0) notes.push(`Kogan skipped some data: ${warnings.join(" | ")}`);

  await logSync(shop, {
    direction: "shopify_to_kogan",
    action: "create",
    status: "success",
    sku: snapshot.sku,
    productId: product.id,
    title: fields.title,
    message: [base, ...notes].join(". "),
    taskId: taskIds.join(", "),
  });

  return true;
}

/**
 * Records a write that Kogan accepted. The product stays "pending" (shown as
 * "Awaiting Kogan") until the app has read it back from Kogan and confirmed
 * that every value was applied.
 */
async function markSynced(shop, link, snapshot, fields, pendingUrls = [], taskIds = []) {
  await prisma.koganProductLink.update({
    where: { id: link.id },
    data: {
      shopifyVariantId: snapshot.variantId,
      inventoryItemId: snapshot.inventoryItemId,
      koganGroupId: fields.variantGroup?.groupId ?? link.koganGroupId,
      snapshot: JSON.stringify(fields),
      koganCategory: categoryOf(fields),
      syncStatus: "pending",
      pendingTaskUrl: pendingUrls.length > 0 ? JSON.stringify(pendingUrls) : null,
      verifyAfter: nextVerifyTime(),
      lastTaskId: taskIds.at(-1) || link.lastTaskId || null,
      syncError: null,
      lastSyncedAt: new Date(),
      lastDirection: "shopify_to_kogan",
    },
  });
}

/**
 * Kogan processes writes asynchronously and can take several minutes. Tasks
 * that were still running when the app stopped waiting are checked here, so
 * a late rejection still shows up as an error.
 */
export async function checkPendingKoganTasks(shop) {
  const links = await prisma.koganProductLink.findMany({
    where: { shop, pendingTaskUrl: { not: null } },
    take: 50,
  });
  if (links.length === 0) return;

  const kogan = createKoganClient(await getSettings(shop));

  for (const link of links) {
    let urls = [];
    try {
      urls = JSON.parse(link.pendingTaskUrl);
    } catch {
      urls = [link.pendingTaskUrl];
    }

    const remaining = [];
    const problems = [];
    const warnings = [];
    const finishedTaskIds = [];

    for (const url of urls) {
      try {
        const task = await kogan.getTask(url);
        if (task.status === "Pending") {
          remaining.push(url);
          continue;
        }
        problems.push(...collectProblems(task, link.koganSku));
        warnings.push(...collectWarnings(task, link.koganSku));
        if (task.taskIds?.length) finishedTaskIds.push(...task.taskIds);
      } catch (error) {
        if (error.status === 404) continue;
        remaining.push(url);
      }
    }

    const ageHours = (Date.now() - new Date(link.updatedAt).getTime()) / 3600000;
    const giveUp = remaining.length > 0 && ageHours > 24;
    const title = link.snapshot ? JSON.parse(link.snapshot).title : null;

    if (problems.some(isNotFoundProblem)) {
      await relistMissingSku(kogan, shop, link, problems, finishedTaskIds);
      continue;
    }

    if (problems.length > 0) {
      await prisma.koganProductLink.update({
        where: { id: link.id },
        data: {
          syncStatus: "error",
          syncError: problems.join(" | ").slice(0, 2000),
          pendingTaskUrl: remaining.length && !giveUp ? JSON.stringify(remaining) : null,
          lastTaskId: finishedTaskIds.at(-1) || link.lastTaskId,
        },
      });
      await logSync(shop, {
        direction: "shopify_to_kogan",
        action: "update",
        status: "error",
        sku: link.koganSku,
        productId: link.shopifyProductId,
        title,
        message: `Kogan finished processing and reported: ${withCategoryHint(problems).join(" | ")}`,
        taskId: finishedTaskIds.join(", ") || link.lastTaskId,
      });
      continue;
    }

    if (remaining.length > 0 && !giveUp) {
      if (remaining.length !== urls.length) {
        await prisma.koganProductLink.update({
          where: { id: link.id },
          data: { pendingTaskUrl: JSON.stringify(remaining) },
        });
      }
      continue;
    }

    await prisma.koganProductLink.update({
      where: { id: link.id },
      data: {
        // A finished task is still confirmed against Kogan by the verification step.
        syncStatus: giveUp ? "error" : link.verifyAfter ? "pending" : "synced",
        syncError: giveUp ? "Kogan did not finish processing this update within 24 hours." : null,
        pendingTaskUrl: null,
      },
    });

    if (warnings.length > 0) {
      await logSync(shop, {
        direction: "shopify_to_kogan",
        action: "update",
        status: "success",
        sku: link.koganSku,
        productId: link.shopifyProductId,
        title,
        message: `Kogan finished processing. It skipped some data: ${warnings.join(" | ")}`,
      });
    }
  }
}

async function recordFailure(shop, link, product, sku, action, message, taskIds = []) {
  const taskId = taskIds.filter(Boolean).join(", ") || null;

  if (link) {
    // updateMany does not throw when the link was removed in the meantime.
    await prisma.koganProductLink.updateMany({
      where: { id: link.id },
      data: {
        syncStatus: "error",
        syncError: message.slice(0, 2000),
        lastTaskId: taskIds.at(-1) || link.lastTaskId || null,
      },
    });
  }

  await logSync(shop, {
    direction: "shopify_to_kogan",
    action,
    status: "error",
    sku,
    productId: product.id,
    title: product.title,
    message,
    taskId,
  });
}

const LOCATION_BATCH_SIZE = 100;

/**
 * Sends the stock location from Settings to Kogan for every linked SKU, in
 * batches, followed by each SKU's current price. Kogan stores prices with GST
 * already added for stock that was not located in New Zealand, so the price
 * is sent again once the location is correct.
 */
export function startLocationJob(shop) {
  return startJob(shop, "location", async (counters, progress) => {
    const settings = await getSettings(shop);
    const location = settings.productLocation;
    if (!location) return "No stock location is set in Settings.";

    const kogan = createKoganClient(settings);
    const links = await prisma.koganProductLink.findMany({
      where: { shop },
      orderBy: { koganSku: "asc" },
    });
    counters.total = links.length;
    await progress(true);

    for (let index = 0; index < links.length; index += LOCATION_BATCH_SIZE) {
      const batch = links.slice(index, index + LOCATION_BATCH_SIZE);
      const failed = new Map();
      let pendingUrls = [];
      let taskIds = [];

      try {
        const locationResult = await kogan.updateProducts(
          batch.map((link) => ({ product_sku: link.koganSku, product_location: location })),
        );

        const priced = batch
          .map((link) => ({ link, fields: link.snapshot ? JSON.parse(link.snapshot) : null }))
          .filter(({ fields }) => typeof fields?.price === "string" && Number(fields.price) > 0);
        const priceResult = priced.length
          ? await kogan.updateStockAndPrice(
              priced.map(({ link, fields }) => ({
                product_sku: link.koganSku,
                offer_data: buildOfferData(link, fields),
              })),
            )
          : { errors: [], pendingUrls: [], error: null };

        for (const result of [locationResult, priceResult]) {
          if (result.error) for (const link of batch) failed.set(link.koganSku, result.error);
          for (const entry of result.errors) failed.set(entry.product_sku, formatKoganErrors([entry]));
          pendingUrls = pendingUrls.concat(result.pendingUrls || []);
          taskIds = taskIds.concat(result.taskIds || []);
        }
      } catch (error) {
        for (const link of batch) failed.set(link.koganSku, error.message);
      }

      for (const link of batch) {
        counters.processed += 1;

        if (failed.has(link.koganSku) && isNotFoundProblem(failed.get(link.koganSku))) {
          if (await relistMissingSku(kogan, shop, link, [failed.get(link.koganSku)], taskIds)) {
            counters.created += 1;
          } else {
            counters.failed += 1;
          }
          continue;
        }

        if (failed.has(link.koganSku)) {
          counters.failed += 1;
          await logSync(shop, {
            direction: "shopify_to_kogan",
            action: "update",
            status: "error",
            sku: link.koganSku,
            productId: link.shopifyProductId,
            title: link.snapshot ? JSON.parse(link.snapshot).title : null,
            message: `Could not set the stock location to ${location}: ${failed.get(link.koganSku)}`,
            taskId: taskIds.join(", ") || null,
          });
          continue;
        }

        counters.updated += 1;
        const fields = link.snapshot ? JSON.parse(link.snapshot) : null;
        await prisma.koganProductLink.update({
          where: { id: link.id },
          data: {
            ...(fields ? { snapshot: JSON.stringify({ ...fields, location }) } : {}),
            syncStatus: "pending",
            syncError: null,
            lastTaskId: taskIds.at(-1) || link.lastTaskId,
            pendingTaskUrl: pendingUrls.length ? JSON.stringify(pendingUrls) : null,
            verifyAfter: nextVerifyTime(),
            verifyAttempts: 0,
          },
        });
      }

      await progress(true);
    }

    await logSync(shop, {
      direction: "shopify_to_kogan",
      action: "update",
      status: counters.failed > 0 ? "error" : "success",
      message: `Stock location ${location} sent to Kogan for ${counters.updated} of ${counters.total} SKUs${counters.failed ? ` (${counters.failed} failed)` : ""}. Prices were sent again so Kogan no longer adds GST to them.`,
    });

    return `Stock location ${location} sent to Kogan for ${counters.updated} of ${counters.total} SKUs.`;
  });
}

/**
 * Schedules every linked product to be checked against Kogan on the next
 * background run. Products Kogan does not have are listed again; the rest are
 * confirmed or corrected. Used after the Kogan environment changes.
 */
export async function scheduleFullKoganCheck(shop) {
  const result = await prisma.koganProductLink.updateMany({
    where: { shop },
    data: { verifyAfter: new Date(), verifyAttempts: 0 },
  });
  return result.count;
}

export function startPushAllJob(shop) {
  return startJob(shop, "push", async (counters, progress) => {
    const { admin } = await unauthenticated.admin(shop);
    const settings = await getSettings(shop);
    let unchanged = 0;

    for await (const products of listTaggedProducts(admin, settings.syncTag)) {
      counters.total += products.length;
      await progress(true);

      for (const product of products) {
        try {
          const outcome = await pushProductToKogan(admin, shop, product.id, {
            reason: "manual",
            product,
          });
          counters.created += outcome.created;
          counters.updated += outcome.updated;
          counters.failed += outcome.failed;
          unchanged += outcome.unchanged;
        } catch (error) {
          counters.failed += 1;
          await logSync(shop, {
            direction: "shopify_to_kogan",
            action: "update",
            status: "error",
            productId: product.id,
            title: product.title,
            message: error.message,
          });
        }

        counters.processed += 1;
        await progress();
      }
    }

    await progress(true);
    return `Created ${counters.created}, updated ${counters.updated}, already up to date ${unchanged}.`;
  });
}

// ---------------------------------------------------------------------------
// Verification after a sync
// ---------------------------------------------------------------------------

const VERIFY_DELAY_MS = 10 * 60 * 1000;
const NZ_GST_RATE = 0.15;
const MAX_VERIFY_ATTEMPTS = 3;
const VERIFY_BATCH_SIZE = 50;
const NEW_LISTING_GRACE_MS = 60 * 60 * 1000;
const STORE_LINK_RECHECK_MS = 6 * 60 * 60 * 1000;

export function nextVerifyTime() {
  return new Date(Date.now() + VERIFY_DELAY_MS);
}

/**
 * Compares what Kogan shows with what the app last sent. Returns the snapshot
 * fields that Kogan has not applied, with a readable description of each.
 */
function findUnappliedFields(link, sent, koganProduct) {
  const differences = [];

  if (sent.location && koganProduct.product_location !== sent.location) {
    differences.push({
      field: "location",
      text: `stock location (Kogan ${koganProduct.product_location || "not set"}, Settings ${sent.location})`,
    });
  }

  const offer = koganProduct.offer_data?.[link.currency];
  const koganPrice = toMoneyString(offer?.price);
  if (sent.price && koganPrice !== sent.price) {
    const gstAdded =
      link.currency === "NZD" && koganPrice === toMoneyString(Number(sent.price) * (1 + NZ_GST_RATE));

    if (gstAdded && sent.location !== "NZ" && koganProduct.product_location !== "NZ") {
      // Resending the price would not help: Kogan adds GST again every time.
      differences.push({
        fatal: true,
        text: `Kogan added 15% NZ GST to the price (Kogan ${koganPrice}, Shopify ${sent.price}) because the stock location is not NZ. Set "Stock location" to NZ in Settings`,
      });
    } else {
      differences.push({
        field: "price",
        text: gstAdded
          ? koganProduct.product_location === "NZ"
            ? `price (Kogan ${koganPrice} still includes 15% NZ GST although the stock location on Kogan is NZ, Shopify ${sent.price})`
            : `price (Kogan ${koganPrice} includes 15% NZ GST added while the stock location was not NZ, Shopify ${sent.price})`
          : `price (Kogan ${offer?.price ?? "none"}, Shopify ${sent.price})`,
      });
    }
  }

  if (sent.stock !== null && sent.stock !== undefined) {
    const expected = sent.enabled === false ? 0 : sent.stock;
    if (Number(koganProduct.stock) !== expected) {
      differences.push({ field: "stock", text: `stock (Kogan ${koganProduct.stock}, Shopify ${expected})` });
    }
  }

  if (sent.title && String(koganProduct.product_title || "").trim() !== sent.title.slice(0, 255).trim()) {
    differences.push({ field: "title", text: `title (Kogan "${koganProduct.product_title}")` });
  }

  const expectedGroup = sent.variantGroup?.groupId;
  if (expectedGroup && variantGroupOf(koganProduct)?.groupId !== expectedGroup) {
    differences.push({ field: "variantGroup", text: "variant group" });
  }

  return differences;
}

/**
 * Kogan answers "Complete" when it accepts a write, but on a busy queue the
 * change can be applied late, out of order, or not at all. A while after each
 * sync the app reads the product back from Kogan; anything that did not stick
 * is sent again, up to three times, before the product is flagged as an error.
 */
export async function verifyKoganState(shop) {
  // Products listed from Shopify have no Kogan store link yet. They are
  // checked against Kogan (at most every few hours) so "View on Kogan" fills
  // in by itself.
  await prisma.koganProductLink.updateMany({
    where: {
      shop,
      koganStoreUrl: null,
      verifyAfter: null,
      pendingTaskUrl: null,
      syncStatus: "synced",
      updatedAt: { lt: new Date(Date.now() - STORE_LINK_RECHECK_MS) },
    },
    data: { verifyAfter: new Date() },
  });

  const links = await prisma.koganProductLink.findMany({
    where: { shop, verifyAfter: { lte: new Date() }, pendingTaskUrl: null },
    orderBy: { verifyAfter: "asc" },
    take: VERIFY_BATCH_SIZE,
  });
  if (links.length === 0) return;

  const kogan = createKoganClient(await getSettings(shop));
  const resend = new Set();

  for (const link of links) {
    let sent;
    try {
      sent = link.snapshot ? JSON.parse(link.snapshot) : null;
    } catch {
      sent = null;
    }
    if (!sent) {
      await prisma.koganProductLink.update({ where: { id: link.id }, data: { verifyAfter: null } });
      continue;
    }

    let koganProduct;
    try {
      koganProduct = await kogan.getProductBySku(link.koganSku);
    } catch {
      // Kogan could not be reached; try again on a later tick.
      await prisma.koganProductLink.update({ where: { id: link.id }, data: { verifyAfter: nextVerifyTime() } });
      continue;
    }

    if (!koganProduct) {
      // A brand-new listing can take a while to appear on Kogan.
      if (Date.now() - new Date(link.createdAt).getTime() < NEW_LISTING_GRACE_MS) {
        await prisma.koganProductLink.update({ where: { id: link.id }, data: { verifyAfter: nextVerifyTime() } });
        continue;
      }
      await relistMissingSku(kogan, shop, link, ["The product is not on Kogan"], [link.lastTaskId]);
      continue;
    }

    const storeUrl = koganProduct.store_urls?.[0]?.url || null;
    if (storeUrl && storeUrl !== link.koganStoreUrl) {
      await prisma.koganProductLink.update({ where: { id: link.id }, data: { koganStoreUrl: storeUrl } });
    }

    const differences = findUnappliedFields(link, sent, koganProduct);

    if (differences.length === 0) {
      await prisma.koganProductLink.update({
        where: { id: link.id },
        data: { verifyAfter: null, verifyAttempts: 0, syncStatus: "synced", syncError: null, koganHost: hostOf(kogan) },
      });
      // Routine re-checks of products that were already synced are not logged.
      if (link.syncStatus !== "synced") {
        await logSync(shop, {
          direction: "shopify_to_kogan",
          action: "update",
          status: "success",
          sku: link.koganSku,
          productId: link.shopifyProductId,
          title: sent.title || link.koganSku,
          message: "Confirmed on Kogan: the product on Kogan matches Shopify.",
          taskId: link.lastTaskId,
        });
      }
      continue;
    }

    const summary = differences.map((item) => item.text).join(", ");
    const title = sent.title || link.koganSku;

    const fatal = differences.find((item) => item.fatal);
    if (fatal) {
      await prisma.koganProductLink.update({
        where: { id: link.id },
        data: {
          verifyAfter: null,
          verifyAttempts: 0,
          syncStatus: "error",
          syncError: `${fatal.text}.${link.lastTaskId ? ` Last Kogan task ID: ${link.lastTaskId}.` : ""}`,
        },
      });
      await logSync(shop, {
        direction: "shopify_to_kogan",
        action: "update",
        status: "error",
        sku: link.koganSku,
        productId: link.shopifyProductId,
        title,
        message: `${fatal.text}.`,
        taskId: link.lastTaskId,
      });
      continue;
    }

    if (link.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
      await prisma.koganProductLink.update({
        where: { id: link.id },
        data: {
          verifyAfter: null,
          verifyAttempts: 0,
          syncStatus: "error",
          syncError: `Kogan has not applied these changes after ${MAX_VERIFY_ATTEMPTS} attempts: ${summary}. Use "Sync now" to try again, or send the Kogan task ID to Kogan support if it continues.${link.lastTaskId ? ` Last Kogan task ID: ${link.lastTaskId}.` : ""}`,
        },
      });
      await logSync(shop, {
        direction: "shopify_to_kogan",
        action: "update",
        status: "error",
        sku: link.koganSku,
        productId: link.shopifyProductId,
        title,
        message: `Kogan has not applied these changes after ${MAX_VERIFY_ATTEMPTS} attempts: ${summary}.`,
        taskId: link.lastTaskId,
      });
      continue;
    }

    // Mark the fields as unsent so the next push includes them again.
    const marked = { ...sent };
    for (const { field } of differences) marked[field] = { resend: true };

    await prisma.koganProductLink.update({
      where: { id: link.id },
      data: {
        snapshot: JSON.stringify(marked),
        verifyAfter: null,
        verifyAttempts: link.verifyAttempts + 1,
      },
    });
    await logSync(shop, {
      direction: "shopify_to_kogan",
      action: "update",
      status: "success",
      sku: link.koganSku,
      productId: link.shopifyProductId,
      title,
      message: `Checked Kogan: it had not applied the ${summary}. Sending it again (attempt ${link.verifyAttempts + 1} of ${MAX_VERIFY_ATTEMPTS}).`,
      taskId: link.lastTaskId,
    });
    resend.add(link.shopifyProductId);
  }

  for (const productId of resend) {
    schedulePush(shop, productId, "verify");
  }
}

// ---------------------------------------------------------------------------
// Deletions and inventory events
// ---------------------------------------------------------------------------

/**
 * The Kogan API has no endpoint to delete a product. The documented way to
 * take it off a store is to delist it by sending `null` as the offer for that
 * store's currency. Stock is set to 0 as well, and the product is disabled
 * when the seller account has permission for the status API.
 */
async function removeFromKogan(kogan, shop, link) {
  if (!statusApiForbidden.has(shop)) {
    try {
      await kogan.updateEnabledStatus([{ product_sku: link.koganSku, enabled: false }]);
    } catch (error) {
      if (error.status === 403) statusApiForbidden.add(shop);
    }
  }

  const delist = await kogan.updateStockAndPrice([
    { product_sku: link.koganSku, stock: 0, offer_data: { [link.currency]: null } },
  ]);
  const problems = collectProblems(delist);

  if (problems.length > 0) {
    // Fall back to stock 0 so the product at least cannot be bought.
    const fallback = await kogan.updateStockAndPrice([{ product_sku: link.koganSku, stock: 0 }]);
    const fallbackProblems = collectProblems(fallback);
    throw new Error(
      fallbackProblems.length > 0
        ? `Could not remove the product from Kogan: ${problems.join(" | ")}`
        : `Kogan refused to delist the product (${problems.join(" | ")}), so its stock was set to 0 instead.`,
    );
  }
}

export async function handleProductDeleted(shop, productId) {
  const links = await prisma.koganProductLink.findMany({
    where: { shop, shopifyProductId: productId },
  });
  if (links.length === 0) return;

  const settings = await getSettings(shop);

  if (settings.zeroStockOnDelete) {
    const kogan = createKoganClient(settings);

    for (const link of links) {
      const title = link.snapshot ? JSON.parse(link.snapshot).title : null;

      try {
        await removeFromKogan(kogan, shop, link);
        await logSync(shop, {
          direction: "shopify_to_kogan",
          action: "delete",
          status: "success",
          sku: link.koganSku,
          productId,
          title,
          message: "Deleted in Shopify, so the product was removed from sale on Kogan.",
        });
      } catch (error) {
        await logSync(shop, {
          direction: "shopify_to_kogan",
          action: "delete",
          status: "error",
          sku: link.koganSku,
          productId,
          title,
          message: error.message,
        });
      }
    }
  }

  await prisma.koganProductLink.deleteMany({ where: { shop, shopifyProductId: productId } });
  await retireSkus(
    shop,
    links.map((link) => ({ sku: link.koganSku, title: link.snapshot ? JSON.parse(link.snapshot).title : null })),
    "removed",
  );
}

export async function scheduleInventoryPush(shop, inventoryItemId) {
  const link = await prisma.koganProductLink.findFirst({
    where: { shop, inventoryItemId },
    select: { shopifyProductId: true },
  });

  if (link) {
    schedulePush(shop, link.shopifyProductId, "webhook");
  }
}
