-- CreateTable
CREATE TABLE "KoganRetiredSku" (
    "shop" TEXT NOT NULL,
    "koganSku" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("shop", "koganSku")
);

-- Backfill: SKUs the app already took off Kogan because they were deleted or
-- renamed in Shopify, and that no Shopify product is linked to any more.
INSERT OR IGNORE INTO "KoganRetiredSku" ("shop", "koganSku", "reason", "title", "createdAt")
SELECT "shop", "sku", 'removed', MAX("title"), MAX("createdAt")
FROM "SyncLog"
WHERE "action" = 'delete'
  AND "direction" = 'shopify_to_kogan'
  AND "sku" IS NOT NULL
  AND "sku" NOT LIKE '%,%'
  AND NOT EXISTS (
    SELECT 1 FROM "KoganProductLink" AS "link"
    WHERE "link"."shop" = "SyncLog"."shop" AND "link"."koganSku" = "SyncLog"."sku"
  )
GROUP BY "shop", "sku";
