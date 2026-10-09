const WEIGHT_TO_KG = {
  KILOGRAMS: 1,
  GRAMS: 0.001,
  POUNDS: 0.45359237,
  OUNCES: 0.028349523125,
};

export function toMoneyString(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : null;
}

/**
 * Reads a "Kogan price" metafield value. Empty, zero or invalid values mean
 * "not set", so the Shopify price is used instead.
 */
export function parseKoganPrice(value) {
  const price = toMoneyString(value);
  return price && Number(price) > 0 ? price : null;
}

/**
 * Picks the offer for the preferred currency, or the first offer Kogan has.
 */
export function pickOffer(koganProduct, preferredCurrency) {
  const offers = koganProduct.offer_data || {};
  const currency = offers[preferredCurrency]
    ? preferredCurrency
    : Object.keys(offers)[0] || preferredCurrency;

  return { currency, offer: offers[currency] || {} };
}

function facetValue(koganProduct, varyOn) {
  const facets = koganProduct.facets || [];
  const inGroup = facets
    .find((facet) => facet.group === varyOn.group)
    ?.items?.find((item) => item.type === varyOn.type);
  if (inGroup?.value) return inGroup.value;

  for (const facet of facets) {
    const item = facet.items?.find((entry) => entry.type === varyOn.type);
    if (item?.value) return item.value;
  }
  return null;
}

/**
 * Kogan stores IDs with the seller's code in front ("EIT-TEST-001") and adds
 * that code again to every group ID it receives. The code is read from the
 * product's image paths, which contain "<code>-<sku>".
 */
function sellerPrefixOf(koganProduct) {
  const sku = koganProduct.product_sku;
  if (!sku) return null;

  for (const url of koganProduct.images || []) {
    for (const segment of String(url).split("?")[0].split("/")) {
      if (segment.length > sku.length + 1 && segment.endsWith(`-${sku}`)) {
        return segment.slice(0, -(sku.length + 1));
      }
    }
  }
  return null;
}

/**
 * Returns the group ID without the seller code, which is the form Kogan
 * expects when the group is sent back.
 */
function unprefixedGroupId(koganProduct, groupId) {
  const prefix = sellerPrefixOf(koganProduct);
  const id = String(groupId);
  return prefix && id.startsWith(`${prefix}-`) ? id.slice(prefix.length + 1) : id;
}

/**
 * Kogan lists every variant as its own product and links them with a shared
 * `variant.group_id`. Each group varies on up to three facets, which become
 * the Shopify product options.
 */
export function variantGroupOf(koganProduct) {
  const variant = koganProduct.variant;
  if (!variant?.group_id) return null;

  const varyOn = [variant.vary_on, variant.vary_on_2, variant.vary_on_3].filter(
    (item) => item?.type,
  );
  if (varyOn.length === 0) return null;

  return {
    groupId: unprefixedGroupId(koganProduct, variant.group_id),
    groupTitle: variant.group_title || null,
    varyOn,
    options: varyOn.map((item) => ({
      name: item.type,
      value: facetValue(koganProduct, item) || "Default",
    })),
  };
}

/**
 * Kogan's category slug ends with the category ID
 * ("boat-parts-accessories-12v-appliances-46114"). The ID form is stored
 * because Kogan does not reliably accept category names on update.
 */
function koganCategoryId(koganProduct) {
  const id = String(koganProduct.category_slug || "").match(/-(\d+)$/)?.[1];
  return id ? `kogan:${id}` : null;
}

/**
 * Converts a Kogan product into the values used to create or update a
 * Shopify product.
 */
export function mapKoganToShopify(koganProduct, settings) {
  const { currency, offer } = pickOffer(koganProduct, settings.currency);
  const listed = Boolean(offer.price);
  const price = toMoneyString(offer.price) || "0.00";
  const rrp = toMoneyString(offer.rrp);

  return {
    sku: koganProduct.product_sku,
    title: koganProduct.product_title || koganProduct.product_sku,
    descriptionHtml: koganProduct.product_description || "",
    vendor: koganProduct.brand || "",
    productType: koganProduct.category || "",
    category: koganCategoryId(koganProduct) || koganProduct.category || "",
    // Products without an offer are delisted on Kogan and have no price, so
    // they are imported as drafts.
    status: !listed || koganProduct.enabled === false || !settings.importAsActive ? "DRAFT" : "ACTIVE",
    listed,
    tags: [settings.syncTag],
    images: (koganProduct.images || []).filter(Boolean),
    price,
    compareAtPrice: rrp && Number(rrp) > Number(price) ? rrp : null,
    barcode: koganProduct.product_gtin || null,
    weightKg: Number(koganProduct.product_dimensions?.weight) || 0,
    stock: Math.max(0, Number(koganProduct.stock) || 0),
    requiresShipping: koganProduct.product_type !== "Digital",
    variantGroup: variantGroupOf(koganProduct),
    currency,
    handlingDays: Number(offer.handling_days) || settings.handlingDays,
    shipping: offer.shipping ?? null,
    storeUrl: koganProduct.store_urls?.[0]?.url || null,
  };
}

export function imagesKey(images) {
  return (images || []).join("\n");
}

function variantWeightKg(variant) {
  const weight = variant.inventoryItem?.measurement?.weight;
  if (!weight?.value) return 0;
  return Math.round(weight.value * (WEIGHT_TO_KG[weight.unit] ?? 1) * 1000) / 1000;
}

/**
 * Orders a variant's images for Kogan: the variant's own image first, then
 * the rest of the product images.
 */
function variantMediaIds(product, variant) {
  const productIds = (product.media?.nodes || []).map((media) => media.id);
  const ownId = variant.media?.nodes?.[0]?.id;
  if (!ownId) return productIds;
  return [ownId, ...productIds.filter((id) => id !== ownId)];
}

/**
 * Builds a comparable snapshot per SKU from a Shopify product. The same
 * function is used after an import and when a webhook arrives, so a webhook
 * triggered by the app's own write produces an identical snapshot and nothing
 * is pushed back to Kogan.
 *
 * The Kogan price comes from the "Kogan price" metafield (variant first, then
 * product) and falls back to the Shopify price when the metafield is empty.
 */
export function buildSnapshots(product) {
  const allVariants = product.variants?.nodes || [];
  const variants = allVariants.filter((variant) => variant.sku?.trim());
  const multiple = allVariants.length > 1;
  const productKoganPrice = parseKoganPrice(product.koganPrice?.value);

  return variants.map((variant) => {
    const koganPrice = parseKoganPrice(variant.koganPrice?.value) || productKoganPrice;

    return {
      sku: variant.sku.trim(),
      variantId: variant.id,
      inventoryItemId: variant.inventoryItem?.id || null,
      options: (variant.selectedOptions || []).filter((option) => option.name !== "Title"),
      fields: {
        title: multiple && variant.title !== "Default Title"
          ? `${product.title} - ${variant.title}`
          : product.title,
        description: product.descriptionHtml || "",
        brand: product.vendor || "",
        category: product.koganCategory?.value?.trim() || "",
        gtin: variant.barcode || "",
        weight: variantWeightKg(variant),
        productType: variant.inventoryItem?.requiresShipping === false ? "Digital" : "Physical",
        images: variantMediaIds(product, variant),
        price: koganPrice || toMoneyString(variant.price),
        rrp: toMoneyString(variant.compareAtPrice),
        stock: variant.inventoryItem?.tracked === false
          ? null
          : Math.max(0, variant.inventoryQuantity ?? 0),
        enabled: product.status === "ACTIVE",
      },
    };
  });
}

/**
 * Resolves the image URLs for a snapshot's media IDs, or null while any of
 * them is still being processed by Shopify.
 */
export function readyImageUrls(product, mediaIds) {
  const urls = new Map();
  for (const media of product.media?.nodes || []) urls.set(media.id, media.image?.url || null);
  for (const variant of product.variants?.nodes || []) {
    for (const media of variant.media?.nodes || []) {
      if (!urls.get(media.id)) urls.set(media.id, media.image?.url || null);
    }
  }

  const ids = mediaIds || [...urls.keys()];
  const list = ids.map((id) => urls.get(id) || null);
  return list.every(Boolean) ? list.slice(0, 10) : null;
}

/**
 * Lists the fields that changed. A field missing from an older snapshot is
 * treated as unchanged, so adding new fields never causes a burst of updates.
 */
export function diffFields(previous, next) {
  if (!previous) return Object.keys(next);

  return Object.keys(next).filter(
    (key) =>
      key in previous &&
      JSON.stringify(previous[key] ?? null) !== JSON.stringify(next[key] ?? null),
  );
}
