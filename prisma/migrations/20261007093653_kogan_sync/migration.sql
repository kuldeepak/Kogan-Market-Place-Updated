-- CreateTable
CREATE TABLE "KoganSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "sellerId" TEXT,
    "sellerToken" TEXT,
    "apiBaseUrl" TEXT,
    "syncTag" TEXT NOT NULL DEFAULT 'Kogan',
    "currency" TEXT NOT NULL DEFAULT 'AUD',
    "defaultCategory" TEXT,
    "handlingDays" INTEGER NOT NULL DEFAULT 2,
    "productLocation" TEXT,
    "autoSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createOnKogan" BOOLEAN NOT NULL DEFAULT true,
    "zeroStockOnDelete" BOOLEAN NOT NULL DEFAULT true,
    "importAsActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "KoganProductLink" (
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
    "snapshot" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'synced',
    "syncError" TEXT,
    "lastSyncedAt" DATETIME,
    "lastDirection" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sku" TEXT,
    "productId" TEXT,
    "title" TEXT,
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "KoganProductLink_shop_shopifyProductId_idx" ON "KoganProductLink"("shop", "shopifyProductId");

-- CreateIndex
CREATE INDEX "KoganProductLink_shop_inventoryItemId_idx" ON "KoganProductLink"("shop", "inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "KoganProductLink_shop_koganSku_key" ON "KoganProductLink"("shop", "koganSku");

-- CreateIndex
CREATE INDEX "SyncJob_shop_startedAt_idx" ON "SyncJob"("shop", "startedAt");

-- CreateIndex
CREATE INDEX "SyncLog_shop_createdAt_idx" ON "SyncLog"("shop", "createdAt");
