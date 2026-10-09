-- CreateTable
CREATE TABLE "KoganOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "koganOrderId" TEXT NOT NULL,
    "orderLabel" TEXT,
    "shopifyOrderId" TEXT,
    "shopifyName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'imported',
    "currency" TEXT NOT NULL,
    "totalPrice" TEXT NOT NULL,
    "customerName" TEXT,
    "items" TEXT NOT NULL,
    "orderDate" DATETIME NOT NULL,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_KoganSettings" (
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
    "orderSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "orderSyncMinutes" INTEGER NOT NULL DEFAULT 10,
    "lastOrderSyncAt" DATETIME,
    "lastOrderSyncError" TEXT,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_KoganSettings" ("apiBaseUrl", "autoSyncEnabled", "createOnKogan", "currency", "defaultCategory", "handlingDays", "importAsActive", "productLocation", "sellerId", "sellerToken", "shop", "syncTag", "updatedAt", "zeroStockOnDelete") SELECT "apiBaseUrl", "autoSyncEnabled", "createOnKogan", "currency", "defaultCategory", "handlingDays", "importAsActive", "productLocation", "sellerId", "sellerToken", "shop", "syncTag", "updatedAt", "zeroStockOnDelete" FROM "KoganSettings";
DROP TABLE "KoganSettings";
ALTER TABLE "new_KoganSettings" RENAME TO "KoganSettings";
CREATE TABLE "new_SyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);
INSERT INTO "new_SyncJob" ("created", "failed", "finishedAt", "id", "message", "processed", "shop", "startedAt", "status", "total", "type", "updated") SELECT "created", "failed", "finishedAt", "id", "message", "processed", "shop", "startedAt", "status", "total", "type", "updated" FROM "SyncJob";
DROP TABLE "SyncJob";
ALTER TABLE "new_SyncJob" RENAME TO "SyncJob";
CREATE INDEX "SyncJob_shop_startedAt_idx" ON "SyncJob"("shop", "startedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "KoganOrder_shop_shopifyOrderId_idx" ON "KoganOrder"("shop", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "KoganOrder_shop_orderDate_idx" ON "KoganOrder"("shop", "orderDate");

-- CreateIndex
CREATE UNIQUE INDEX "KoganOrder_shop_koganOrderId_key" ON "KoganOrder"("shop", "koganOrderId");
