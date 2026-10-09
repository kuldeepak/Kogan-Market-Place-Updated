-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_KoganOrder" (
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
    "fulfillmentIds" TEXT NOT NULL DEFAULT '[]',
    "orderDate" DATETIME NOT NULL,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_KoganOrder" ("createdAt", "currency", "customerName", "error", "id", "items", "koganOrderId", "orderDate", "orderLabel", "shop", "shopifyName", "shopifyOrderId", "status", "totalPrice", "updatedAt") SELECT "createdAt", "currency", "customerName", "error", "id", "items", "koganOrderId", "orderDate", "orderLabel", "shop", "shopifyName", "shopifyOrderId", "status", "totalPrice", "updatedAt" FROM "KoganOrder";
DROP TABLE "KoganOrder";
ALTER TABLE "new_KoganOrder" RENAME TO "KoganOrder";
CREATE INDEX "KoganOrder_shop_shopifyOrderId_idx" ON "KoganOrder"("shop", "shopifyOrderId");
CREATE INDEX "KoganOrder_shop_orderDate_idx" ON "KoganOrder"("shop", "orderDate");
CREATE UNIQUE INDEX "KoganOrder_shop_koganOrderId_key" ON "KoganOrder"("shop", "koganOrderId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
