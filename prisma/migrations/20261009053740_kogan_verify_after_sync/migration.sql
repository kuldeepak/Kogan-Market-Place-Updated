-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_KoganProductLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "koganSku" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT,
    "inventoryItemId" TEXT,
    "currency" TEXT NOT NULL,
    "handlingDays" INTEGER NOT NULL DEFAULT 2,
    "shipping" TEXT,
    "koganImagesKey" TEXT,
    "koganStoreUrl" TEXT,
    "koganGroupId" TEXT,
    "snapshot" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'synced',
    "syncError" TEXT,
    "pendingTaskUrl" TEXT,
    "verifyAfter" DATETIME,
    "verifyAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" DATETIME,
    "lastDirection" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_KoganProductLink" ("createdAt", "currency", "handlingDays", "id", "inventoryItemId", "koganGroupId", "koganImagesKey", "koganSku", "koganStoreUrl", "lastDirection", "lastSyncedAt", "pendingTaskUrl", "shipping", "shop", "shopifyProductId", "shopifyVariantId", "snapshot", "syncError", "syncStatus", "updatedAt") SELECT "createdAt", "currency", "handlingDays", "id", "inventoryItemId", "koganGroupId", "koganImagesKey", "koganSku", "koganStoreUrl", "lastDirection", "lastSyncedAt", "pendingTaskUrl", "shipping", "shop", "shopifyProductId", "shopifyVariantId", "snapshot", "syncError", "syncStatus", "updatedAt" FROM "KoganProductLink";
DROP TABLE "KoganProductLink";
ALTER TABLE "new_KoganProductLink" RENAME TO "KoganProductLink";
CREATE INDEX "KoganProductLink_shop_shopifyProductId_idx" ON "KoganProductLink"("shop", "shopifyProductId");
CREATE INDEX "KoganProductLink_shop_inventoryItemId_idx" ON "KoganProductLink"("shop", "inventoryItemId");
CREATE INDEX "KoganProductLink_shop_koganGroupId_idx" ON "KoganProductLink"("shop", "koganGroupId");
CREATE INDEX "KoganProductLink_shop_verifyAfter_idx" ON "KoganProductLink"("shop", "verifyAfter");
CREATE UNIQUE INDEX "KoganProductLink_shop_koganSku_key" ON "KoganProductLink"("shop", "koganSku");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
