import { randomUUID } from "node:crypto";

export const KOGAN_CATEGORY_METAFIELD = {
  namespace: "$app",
  key: "kogan_category",
  type: "single_line_text_field",
};

export const KOGAN_PRICE_METAFIELD = {
  namespace: "$app",
  key: "kogan_price",
  type: "number_decimal",
};

const MAX_RETRIES = 5;
const locationCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottled(error) {
  const text = JSON.stringify(error?.body?.errors || error?.message || "");
  return text.includes("THROTTLED") || text.includes("Throttled");
}

/**
 * Runs an Admin GraphQL operation, retrying when Shopify throttles the app,
 * and throws when the response contains top-level errors.
 */
export async function shopifyGraphql(admin, query, variables = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await admin.graphql(query, { variables });
      const json = await response.json();

      if (json.errors?.length) {
        const error = new Error(json.errors.map((item) => item.message).join("; "));
        error.body = json;
        throw error;
      }

      return json.data;
    } catch (error) {
      if (isThrottled(error) && attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }

      const details = error?.body?.errors?.graphQLErrors || error?.body?.errors;
      if (details && !error.message.includes(":")) {
        error.message = `${error.message}: ${JSON.stringify(details).slice(0, 500)}`;
      }
      throw error;
    }
  }
}

function assertNoUserErrors(result, operation) {
  const userErrors = result?.userErrors || [];

  if (userErrors.length > 0) {
    throw new Error(
      `${operation} failed: ${userErrors
        .map((item) => `${(item.field || []).join(".")} ${item.message}`.trim())
        .join("; ")}`,
    );
  }
}

const SYNC_PRODUCT_FIELDS = `#graphql
  fragment SyncProductFields on Product {
    id
    title
    handle
    status
    vendor
    productType
    descriptionHtml
    tags
    updatedAt
    featuredMedia {
      preview {
        image {
          url(transform: { maxWidth: 120, maxHeight: 120 })
        }
      }
    }
    media(first: 20) {
      nodes {
        id
        status
        ... on MediaImage {
          image {
            url
          }
        }
      }
    }
    koganCategory: metafield(namespace: "$app", key: "kogan_category") {
      value
    }
    koganPrice: metafield(namespace: "$app", key: "kogan_price") {
      value
    }
    options {
      name
    }
    variants(first: 100) {
      nodes {
        id
        title
        sku
        price
        compareAtPrice
        barcode
        inventoryQuantity
        selectedOptions {
          name
          value
        }
        koganPrice: metafield(namespace: "$app", key: "kogan_price") {
          value
        }
        media(first: 1) {
          nodes {
            id
            ... on MediaImage {
              image {
                url
              }
            }
          }
        }
        inventoryItem {
          id
          tracked
          requiresShipping
          measurement {
            weight {
              value
              unit
            }
          }
        }
      }
    }
  }
`;

export async function getProductForSync(admin, productId) {
  const data = await shopifyGraphql(
    admin,
    `#graphql
      ${SYNC_PRODUCT_FIELDS}
      query GetProductForSync($id: ID!) {
        product(id: $id) {
          ...SyncProductFields
        }
      }
    `,
    { id: productId },
  );

  return data.product;
}

export async function getProductIdForInventoryItem(admin, inventoryItemId) {
  const data = await shopifyGraphql(
    admin,
    `#graphql
      query ProductForInventoryItem($id: ID!) {
        inventoryItem(id: $id) {
          variant {
            product {
              id
            }
          }
        }
      }
    `,
    { id: inventoryItemId },
  );

  return data.inventoryItem?.variant?.product?.id || null;
}

/**
 * Lists every product carrying the sync tag, one page at a time.
 */
export async function* listTaggedProducts(admin, syncTag) {
  let after = null;

  do {
    const data = await shopifyGraphql(
      admin,
      `#graphql
        ${SYNC_PRODUCT_FIELDS}
        query TaggedProducts($query: String!, $after: String) {
          products(first: 25, after: $after, query: $query) {
            nodes {
              ...SyncProductFields
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      { query: `tag:'${syncTag.replace(/'/g, "\\'")}'`, after },
    );

    yield data.products.nodes;
    after = data.products.pageInfo.hasNextPage
      ? data.products.pageInfo.endCursor
      : null;
  } while (after);
}

/**
 * Looks up many SKUs with as few requests as possible. Returns a map of
 * SKU -> { productId, variantId } for every SKU that exists in Shopify.
 */
export async function findVariantsBySkus(admin, skus) {
  const found = new Map();
  const unique = [...new Set(skus.filter(Boolean))];
  const chunkSize = 25;

  for (let index = 0; index < unique.length; index += chunkSize) {
    const chunk = unique.slice(index, index + chunkSize);
    const query = chunk.map((sku) => `sku:"${sku.replace(/"/g, '\\"')}"`).join(" OR ");
    const data = await shopifyGraphql(
      admin,
      `#graphql
        query VariantsBySkus($query: String!) {
          productVariants(first: 100, query: $query) {
            nodes {
              id
              sku
              product {
                id
              }
            }
          }
        }
      `,
      { query },
    );

    for (const variant of data.productVariants.nodes) {
      const sku = variant.sku?.trim();
      if (chunk.includes(sku) && !found.has(sku)) {
        found.set(sku, { productId: variant.product.id, variantId: variant.id });
      }
    }
  }

  return found;
}

export async function getExistingProductIds(admin, productIds) {
  const existing = new Set();
  const unique = [...new Set(productIds)];

  for (let index = 0; index < unique.length; index += 100) {
    const data = await shopifyGraphql(
      admin,
      `#graphql
        query ExistingProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
            }
          }
        }
      `,
      { ids: unique.slice(index, index + 100) },
    );

    for (const node of data.nodes) {
      if (node?.id) existing.add(node.id);
    }
  }

  return existing;
}

const ensuredDefinitions = new Set();

/**
 * Creates the variant-level "Kogan price" metafield definition. The Shopify
 * CLI cannot declare variant metafields in shopify.app.toml, so the app
 * creates it through the Admin API the first time the shop opens the app.
 */
export async function ensureVariantKoganPriceDefinition(admin, shop) {
  if (ensuredDefinitions.has(shop)) return;

  const existing = await shopifyGraphql(
    admin,
    `#graphql
      query VariantKoganPriceDefinition {
        metafieldDefinitions(first: 1, ownerType: PRODUCTVARIANT, namespace: "$app", key: "kogan_price") {
          nodes {
            id
          }
        }
      }
    `,
  );

  if (existing.metafieldDefinitions.nodes.length === 0) {
    const data = await shopifyGraphql(
      admin,
      `#graphql
        mutation CreateVariantKoganPriceDefinition($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition {
              id
            }
            userErrors {
              field
              message
              code
            }
          }
        }
      `,
      {
        definition: {
          namespace: KOGAN_PRICE_METAFIELD.namespace,
          key: KOGAN_PRICE_METAFIELD.key,
          type: KOGAN_PRICE_METAFIELD.type,
          ownerType: "PRODUCTVARIANT",
          name: "Kogan price",
          description:
            "Price for this variant on Kogan. Overrides the product's Kogan price. Leave empty to use the product's Kogan price or the Shopify price.",
          validations: [{ name: "min", value: "0" }],
          access: { admin: "MERCHANT_READ_WRITE" },
        },
      },
    );

    const errors = data.metafieldDefinitionCreate.userErrors.filter(
      (error) => error.code !== "TAKEN",
    );
    assertNoUserErrors({ userErrors: errors }, "metafieldDefinitionCreate");
  }

  ensuredDefinitions.add(shop);
}

export async function getPrimaryLocationId(admin, shop) {
  if (locationCache.has(shop)) {
    return locationCache.get(shop);
  }

  const data = await shopifyGraphql(
    admin,
    `#graphql
      query SyncLocations {
        locations(first: 20) {
          nodes {
            id
            isActive
            fulfillsOnlineOrders
          }
        }
      }
    `,
  );

  const locations = data.locations.nodes.filter((location) => location.isActive);
  const location =
    locations.find((item) => item.fulfillsOnlineOrders) || locations[0];

  if (!location) {
    throw new Error("No active inventory location was found in Shopify.");
  }

  locationCache.set(shop, location.id);
  return location.id;
}

function detectImageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { mime: "image/jpeg", ext: "jpg" };
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { mime: "image/png", ext: "png" };
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return { mime: "image/gif", ext: "gif" };
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

/**
 * Kogan serves images as `application/octet-stream` without a file extension,
 * which Shopify refuses to import directly. The image is downloaded, its real
 * type is detected, and it is pushed through a staged upload instead.
 */
async function stageImage(admin, imageUrl, filenameBase) {
  try {
    const download = await fetch(imageUrl);
    if (!download.ok) return imageUrl;

    const bytes = new Uint8Array(await download.arrayBuffer());
    const type = detectImageType(bytes);
    if (!type) return imageUrl;

    const filename = `${filenameBase}.${type.ext}`;
    const data = await shopifyGraphql(
      admin,
      `#graphql
        mutation StageImage($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets {
              url
              resourceUrl
              parameters {
                name
                value
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        input: [
          {
            resource: "IMAGE",
            filename,
            mimeType: type.mime,
            httpMethod: "POST",
            fileSize: String(bytes.length),
          },
        ],
      },
    );

    assertNoUserErrors(data.stagedUploadsCreate, "stagedUploadsCreate");
    const target = data.stagedUploadsCreate.stagedTargets[0];

    const form = new FormData();
    for (const parameter of target.parameters) {
      form.append(parameter.name, parameter.value);
    }
    form.append("file", new Blob([bytes], { type: type.mime }), filename);

    const upload = await fetch(target.url, { method: "POST", body: form });
    if (!upload.ok) return imageUrl;

    return target.resourceUrl;
  } catch (error) {
    console.warn(`Image staging failed for ${imageUrl}:`, error.message);
    return imageUrl;
  }
}

async function buildMediaInputs(admin, images, sku, title) {
  const safeBase = sku.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "kogan";
  const inputs = [];

  for (const [index, url] of images.slice(0, 10).entries()) {
    inputs.push({
      originalSource: await stageImage(admin, url, `${safeBase}-${index + 1}`),
      alt: title,
      contentType: "IMAGE",
    });
  }

  return inputs;
}

function weightInput(weightKg) {
  return weightKg > 0
    ? { measurement: { weight: { value: weightKg, unit: "KILOGRAMS" } } }
    : {};
}

function inventoryItemInput(mapped) {
  return {
    sku: mapped.sku,
    tracked: true,
    requiresShipping: mapped.requiresShipping !== false,
    ...weightInput(mapped.weightKg),
  };
}

/**
 * Stages every distinct image of the given products once and returns the
 * media inputs plus a lookup from the Kogan image URL to its staged source.
 */
async function stageImagesFor(admin, members, title) {
  const sources = new Map();
  const files = [];

  for (const member of members) {
    const safeBase = member.sku.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "kogan";

    for (const [index, url] of member.images.slice(0, 10).entries()) {
      if (sources.has(url)) continue;
      const originalSource = await stageImage(admin, url, `${safeBase}-${index + 1}`);
      sources.set(url, originalSource);
      files.push({ originalSource, alt: title, contentType: "IMAGE" });
    }
  }

  return { files, sources };
}

/**
 * Gives every member a unique set of option values. Shopify rejects two
 * variants with identical options, so a clash is resolved with the SKU.
 */
function optionValuesFor(members, optionNames) {
  const seen = new Set();

  return members.map((member) => {
    const values = optionNames.map(
      (name, index) => member.variantGroup?.options?.[index]?.value || "Default",
    );
    let key = values.join(" / ");

    if (seen.has(key)) {
      values[values.length - 1] = `${values[values.length - 1]} (${member.sku})`;
      key = values.join(" / ");
    }
    seen.add(key);

    return optionNames.map((name, index) => ({ optionName: name, name: values[index] }));
  });
}

export function shopifyTitleFor(mapped) {
  return mapped.variantGroup?.groupTitle || mapped.title;
}

/**
 * Creates a Shopify product from one Kogan product, or from several Kogan
 * products that belong to the same variant group. Grouped products become
 * variants with real options, and each variant gets its own image.
 */
export async function createShopifyProduct(admin, members, locationId) {
  const list = Array.isArray(members) ? members : [members];
  const base = list[0];
  const grouped = Boolean(base.variantGroup);
  const title = shopifyTitleFor(base);
  const { files, sources } = await stageImagesFor(admin, list, title);

  const optionNames = grouped ? base.variantGroup.options.map((option) => option.name) : ["Title"];
  const optionValues = grouped
    ? optionValuesFor(list, optionNames)
    : [[{ optionName: "Title", name: "Default Title" }]];

  const productOptions = optionNames.map((name, index) => ({
    name,
    values: [...new Set(optionValues.map((values) => values[index].name))].map((value) => ({
      name: value,
    })),
  }));

  const variants = list.map((member, index) => {
    const ownImage = grouped ? sources.get(member.images[0]) : null;
    return {
      optionValues: optionValues[index],
      price: member.price,
      compareAtPrice: member.compareAtPrice,
      barcode: member.barcode,
      inventoryPolicy: "DENY",
      inventoryItem: inventoryItemInput(member),
      inventoryQuantities: [{ locationId, name: "available", quantity: member.stock }],
      ...(ownImage ? { file: { originalSource: ownImage, alt: member.title, contentType: "IMAGE" } } : {}),
    };
  });

  const data = await shopifyGraphql(
    admin,
    `#graphql
      mutation CreateKoganProduct($input: ProductSetInput!) {
        productSet(input: $input, synchronous: true) {
          product {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      input: {
        title,
        descriptionHtml: base.descriptionHtml,
        vendor: base.vendor,
        productType: base.productType,
        status: list.some((member) => member.status === "ACTIVE") ? "ACTIVE" : "DRAFT",
        tags: base.tags,
        metafields: base.category
          ? [{ ...KOGAN_CATEGORY_METAFIELD, value: base.category }]
          : [],
        files,
        productOptions,
        variants,
      },
    },
  );

  assertNoUserErrors(data.productSet, "productSet");
  return data.productSet.product.id;
}

/**
 * Adds Kogan products from a variant group to the Shopify product that
 * already holds other variants of the same group.
 */
export async function addVariantsToProduct(admin, productId, existing, members, locationId) {
  const optionNames = (existing.options || []).map((option) => option.name);
  const wanted = members[0].variantGroup.options.map((option) => option.name);
  const matches =
    optionNames.length === wanted.length &&
    wanted.every((name, index) => name.toLowerCase() === optionNames[index]?.toLowerCase());

  if (!matches) {
    throw new Error(
      `The Shopify product's options (${optionNames.join(", ") || "none"}) do not match the Kogan variant options (${wanted.join(", ")}).`,
    );
  }

  const title = existing.title;
  const { files, sources } = await stageImagesFor(admin, members, title);
  const optionValues = optionValuesFor(members, optionNames);

  const data = await shopifyGraphql(
    admin,
    `#graphql
      mutation AddKoganVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $media: [CreateMediaInput!]) {
        productVariantsBulkCreate(productId: $productId, variants: $variants, media: $media) {
          productVariants {
            id
            sku
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      productId,
      media: files.map(({ originalSource, alt }) => ({
        originalSource,
        alt,
        mediaContentType: "IMAGE",
      })),
      variants: members.map((member, index) => {
        const ownImage = sources.get(member.images[0]);
        return {
          optionValues: optionValues[index],
          price: member.price,
          compareAtPrice: member.compareAtPrice,
          barcode: member.barcode,
          inventoryPolicy: "DENY",
          inventoryItem: inventoryItemInput(member),
          inventoryQuantities: [{ locationId, availableQuantity: member.stock }],
          ...(ownImage ? { mediaSrc: [ownImage] } : {}),
        };
      }),
    },
  );

  assertNoUserErrors(data.productVariantsBulkCreate, "productVariantsBulkCreate");
}

/**
 * Updates an existing Shopify product in place from mapped Kogan data. Only the
 * linked variant is touched, so other variants and merchant tags are kept.
 *
 * When the product uses a "Kogan price" metafield, the Kogan price is written
 * to that metafield (`koganPriceTarget`) and the Shopify price is left alone.
 */
export async function updateShopifyProduct(admin, {
  productId,
  variantId,
  inventoryItemId,
  mapped,
  replaceImages,
  updateStatus,
  updateStock,
  locationId,
  existing,
  koganPriceTarget = null,
}) {
  const tags = Array.from(new Set([...(existing.tags || []), ...mapped.tags]));
  const productMetafields = [];
  if (mapped.category) productMetafields.push({ ...KOGAN_CATEGORY_METAFIELD, value: mapped.category });
  if (koganPriceTarget === "product") {
    productMetafields.push({ ...KOGAN_PRICE_METAFIELD, value: mapped.price });
  }

  const productData = await shopifyGraphql(
    admin,
    `#graphql
      mutation UpdateKoganProduct($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
        productUpdate(product: $product, media: $media) {
          product {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      product: {
        id: productId,
        title: shopifyTitleFor(mapped),
        descriptionHtml: mapped.descriptionHtml,
        vendor: mapped.vendor,
        productType: mapped.productType,
        tags,
        ...(updateStatus ? { status: mapped.status } : {}),
        metafields: productMetafields,
      },
      media: replaceImages
        ? (await buildMediaInputs(admin, mapped.images, mapped.sku, mapped.title)).map(
            ({ originalSource, alt }) => ({ originalSource, alt, mediaContentType: "IMAGE" }),
          )
        : null,
    },
  );

  assertNoUserErrors(productData.productUpdate, "productUpdate");

  if (replaceImages && existing.media?.nodes?.length) {
    const removal = await shopifyGraphql(
      admin,
      `#graphql
        mutation DetachOldMedia($files: [FileUpdateInput!]!) {
          fileUpdate(files: $files) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        files: existing.media.nodes.map((media) => ({
          id: media.id,
          referencesToRemove: [productId],
        })),
      },
    );
    assertNoUserErrors(removal.fileUpdate, "fileUpdate");
  }

  const variantData = await shopifyGraphql(
    admin,
    `#graphql
      mutation UpdateKoganVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      productId,
      variants: [
        {
          id: variantId,
          ...(koganPriceTarget ? {} : { price: mapped.price }),
          compareAtPrice: mapped.compareAtPrice,
          barcode: mapped.barcode,
          inventoryItem: inventoryItemInput(mapped),
          ...(koganPriceTarget === "variant"
            ? { metafields: [{ ...KOGAN_PRICE_METAFIELD, value: mapped.price }] }
            : {}),
        },
      ],
    },
  );

  assertNoUserErrors(variantData.productVariantsBulkUpdate, "productVariantsBulkUpdate");

  if (updateStock && inventoryItemId) {
    await setInventoryQuantity(admin, inventoryItemId, locationId, mapped.stock);
  }
}

/**
 * Writes SKUs onto variants. `assignments` is a list of { variantId, sku }.
 */
export async function assignVariantSkus(admin, productId, assignments) {
  const data = await shopifyGraphql(
    admin,
    `#graphql
      mutation AssignKoganSkus($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      productId,
      variants: assignments.map(({ variantId, sku }) => ({
        id: variantId,
        inventoryItem: { sku },
      })),
    },
  );

  assertNoUserErrors(data.productVariantsBulkUpdate, "productVariantsBulkUpdate");
}

export async function setInventoryQuantity(admin, inventoryItemId, locationId, quantity) {
  const levelData = await shopifyGraphql(
    admin,
    `#graphql
      query CurrentLevel($id: ID!, $locationId: ID!) {
        inventoryItem(id: $id) {
          tracked
          inventoryLevel(locationId: $locationId) {
            quantities(names: ["available"]) {
              quantity
            }
          }
        }
      }
    `,
    { id: inventoryItemId, locationId },
  );

  const level = levelData.inventoryItem?.inventoryLevel;
  const current = level?.quantities?.[0]?.quantity ?? null;

  if (level && current === quantity) {
    return;
  }

  if (!level) {
    const activation = await shopifyGraphql(
      admin,
      `#graphql
        mutation ActivateInventory($inventoryItemId: ID!, $locationId: ID!) {
          inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      { inventoryItemId, locationId },
    );
    assertNoUserErrors(activation.inventoryActivate, "inventoryActivate");
  }

  const data = await shopifyGraphql(
    admin,
    `#graphql
      mutation SetKoganStock($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      idempotencyKey: randomUUID(),
      input: {
        name: "available",
        reason: "correction",
        referenceDocumentUri: "kogan://marketplace-sync/import",
        quantities: [
          {
            inventoryItemId,
            locationId,
            quantity,
            changeFromQuantity: level ? current : 0,
          },
        ],
      },
    },
  );

  assertNoUserErrors(data.inventorySetQuantities, "inventorySetQuantities");
}

export async function addTagToProduct(admin, productId, tag) {
  const data = await shopifyGraphql(
    admin,
    `#graphql
      mutation AddSyncTag($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    { id: productId, tags: [tag] },
  );

  assertNoUserErrors(data.tagsAdd, "tagsAdd");
}
