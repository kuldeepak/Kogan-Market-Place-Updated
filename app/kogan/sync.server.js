import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { createKoganClient, storeCodeForCurrency } from "./kogan-client.server";
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
  formatKoganErrors,
  getSettings,
  hasSyncTag,
  logSync,
  pruneLogs,
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
    snapshot: snapshot ? JSON.stringify(snapshot.fields) : null,
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
async function importUnit(admin, shop, settings, locationId, unit, existing, updateExisting, results) {
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
  { updateExisting = false } = {},
) {
  const results = new Map();
  const units = [];
  const groups = new Map();

  for (const koganProduct of koganProducts) {
    const sku = koganProduct.product_sku?.trim();
    if (!sku) continue;

    const item = { sku, mapped: mapKoganToShopify(koganProduct, settings) };
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

  await mapWithConcurrency(units, IMPORT_CONCURRENCY, (unit) =>
    importUnit(admin, shop, settings, locationId, unit, existing, updateExisting, results),
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

    for await (const page of kogan.listProducts({ pageSize: 100 })) {
      counters.total += page.length;
      await progress(true);

      const results = await importKoganProducts(admin, shop, settings, locationId, page);

      for (const result of results) {
        if (result.status === "imported") counters.created += 1;
        else if (result.status === "exists") counters.skipped += 1;
        else if (result.status === "failed") counters.failed += 1;
        counters.processed += 1;
      }

      await progress(true);
    }

    return `Imported ${counters.created} new products. ${counters.skipped} already existed in Shopify and were skipped.`;
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

  const links = await prisma.koganProductLink.findMany({
    where: { shop, koganSku: { in: snapshots.map((item) => item.sku) } },
  });

  for (const snapshot of snapshots) {
    let link = links.find((item) => item.koganSku === snapshot.sku);

    try {
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
        } else if (settings.createOnKogan) {
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

/**
 * Converts the app's variant group description into Kogan's format. Each
 * Shopify option becomes a Kogan facet: the facet type is the option name and
 * the facet group is a Kogan group name. The variants vary on those facets.
 */
function koganVariantPayload(group) {
  if (!group?.options?.length) return null;

  const varyOn = group.options.map((option) => ({
    group: (option.group || koganFacetGroupFor(option.name)).slice(0, 255),
    type: option.name.slice(0, 255),
  }));

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
        facets[name].items.push({ type: option.name.slice(0, 255), value: String(option.value).slice(0, 255) });
        return facets;
      }, {}),
    ),
  };
}

function isVariantProblem(problem) {
  return /variant|facet|vary/i.test(problem);
}

function collectWarnings(response) {
  return response.warnings?.length ? [formatKoganErrors(response.warnings)] : [];
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
  if (previous && !("variantGroup" in previous) && next.variantGroup && !changed.includes("variantGroup")) {
    changed.push("variantGroup");
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

  const track = (response, { categoryHint = false } = {}) => {
    const found = collectProblems(response);
    problems.push(...(categoryHint ? withCategoryHint(found) : found));
    warnings.push(...collectWarnings(response));
    pendingUrls.push(...(response.pendingUrls || []));
  };

  if (contentChanges.length > 0) {
    const payload = { product_sku: snapshot.sku };
    if (contentChanges.includes("title")) payload.product_title = next.title.slice(0, 255);
    if (contentChanges.includes("description")) payload.product_description = next.description || next.title;
    if (contentChanges.includes("brand") && next.brand) payload.brand = next.brand;
    if (contentChanges.includes("category") && next.category) {
      payload.category = await resolveCategory(kogan, link.currency, next.category);
    }
    if (contentChanges.includes("gtin") && next.gtin) payload.product_gtin = next.gtin.slice(0, 14);
    if (contentChanges.includes("weight") && next.weight > 0) {
      payload.product_dimensions = { weight: next.weight };
    }
    if (contentChanges.includes("productType")) payload.product_type = next.productType;
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
    await recordFailure(shop, link, product, snapshot.sku, "update", problems.join(" | "));
    return "failed";
  }

  await markSynced(shop, link, snapshot, next, pendingUrls);

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
    message: [`Updated on Kogan: ${labels.join(", ")}`, ...notes].join(". "),
  });

  return "updated";
}

function collectProblems(response) {
  const problems = [];
  if (response.error) problems.push(response.error);
  if (response.errors?.length > 0) problems.push(formatKoganErrors(response.errors));
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
  let grouped = Boolean(grouping);

  // When Kogan refuses only the grouping, the variant is still listed on its
  // own rather than not at all, and the reason is shown in the activity log.
  if (grouping && problems.length > 0 && problems.every(isVariantProblem)) {
    await logVariantRejection(shop, product, snapshot.sku, problems);
    response = await kogan.createProducts([payload]);
    problems = collectProblems(response);
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
    });
    return false;
  }

  const pendingUrls = response.pendingUrls || [];
  const warnings = collectWarnings(response);

  await prisma.koganProductLink.create({
    data: {
      shop,
      koganSku: snapshot.sku,
      shopifyProductId: product.id,
      shopifyVariantId: snapshot.variantId,
      inventoryItemId: snapshot.inventoryItemId,
      currency: settings.currency,
      handlingDays: settings.handlingDays,
      koganGroupId: grouped ? fields.variantGroup.groupId : null,
      snapshot: JSON.stringify(grouped ? fields : { ...fields, variantGroup: null }),
      syncStatus: pendingUrls.length > 0 ? "pending" : "synced",
      pendingTaskUrl: pendingUrls.length > 0 ? JSON.stringify(pendingUrls) : null,
      verifyAfter: nextVerifyTime(),
      lastSyncedAt: new Date(),
      lastDirection: "shopify_to_kogan",
    },
  });

  const base = grouped ? "Created on Kogan as a variant of the product" : "Created on Kogan";
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
  });

  return true;
}

async function markSynced(shop, link, snapshot, fields, pendingUrls = []) {
  await prisma.koganProductLink.update({
    where: { id: link.id },
    data: {
      shopifyVariantId: snapshot.variantId,
      inventoryItemId: snapshot.inventoryItemId,
      koganGroupId: fields.variantGroup?.groupId ?? link.koganGroupId,
      snapshot: JSON.stringify(fields),
      syncStatus: pendingUrls.length > 0 ? "pending" : "synced",
      pendingTaskUrl: pendingUrls.length > 0 ? JSON.stringify(pendingUrls) : null,
      verifyAfter: nextVerifyTime(),
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

    for (const url of urls) {
      try {
        const task = await kogan.getTask(url);
        if (task.status === "Pending") {
          remaining.push(url);
          continue;
        }
        problems.push(...collectProblems(task));
        warnings.push(...collectWarnings(task));
      } catch (error) {
        if (error.status === 404) continue;
        remaining.push(url);
      }
    }

    const ageHours = (Date.now() - new Date(link.updatedAt).getTime()) / 3600000;
    const giveUp = remaining.length > 0 && ageHours > 24;
    const title = link.snapshot ? JSON.parse(link.snapshot).title : null;

    if (problems.length > 0) {
      await prisma.koganProductLink.update({
        where: { id: link.id },
        data: {
          syncStatus: "error",
          syncError: problems.join(" | ").slice(0, 2000),
          pendingTaskUrl: remaining.length && !giveUp ? JSON.stringify(remaining) : null,
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
        syncStatus: giveUp ? "error" : "synced",
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

async function recordFailure(shop, link, product, sku, action, message) {
  if (link) {
    await prisma.koganProductLink.update({
      where: { id: link.id },
      data: { syncStatus: "error", syncError: message.slice(0, 2000) },
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
  });
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
const MAX_VERIFY_ATTEMPTS = 3;
const VERIFY_BATCH_SIZE = 20;

export function nextVerifyTime() {
  return new Date(Date.now() + VERIFY_DELAY_MS);
}

/**
 * Compares what Kogan shows with what the app last sent. Returns the snapshot
 * fields that Kogan has not applied, with a readable description of each.
 */
function findUnappliedFields(link, sent, koganProduct) {
  const differences = [];

  const offer = koganProduct.offer_data?.[link.currency];
  if (sent.price && toMoneyString(offer?.price) !== sent.price) {
    differences.push({ field: "price", text: `price (Kogan ${offer?.price ?? "none"}, Shopify ${sent.price})` });
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

    const differences = koganProduct
      ? findUnappliedFields(link, sent, koganProduct)
      : [{ field: "title", text: "the product is not visible on Kogan yet" }];

    if (differences.length === 0) {
      await prisma.koganProductLink.update({
        where: { id: link.id },
        data: { verifyAfter: null, verifyAttempts: 0 },
      });
      continue;
    }

    const summary = differences.map((item) => item.text).join(", ");
    const title = sent.title || link.koganSku;

    if (link.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
      await prisma.koganProductLink.update({
        where: { id: link.id },
        data: {
          verifyAfter: null,
          verifyAttempts: 0,
          syncStatus: "error",
          syncError: `Kogan has not applied these changes after ${MAX_VERIFY_ATTEMPTS} attempts: ${summary}. Use "Sync now" to try again, or contact Kogan support if it continues.`,
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
