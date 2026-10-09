-- AlterTable
ALTER TABLE "KoganProductLink" ADD COLUMN "pendingTaskUrl" TEXT;

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
    "autoGenerateSkus" BOOLEAN NOT NULL DEFAULT true,
    "orderSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "orderSyncMinutes" INTEGER NOT NULL DEFAULT 10,
    "lastOrderSyncAt" DATETIME,
    "lastOrderSyncError" TEXT,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_KoganSettings" ("apiBaseUrl", "autoSyncEnabled", "createOnKogan", "currency", "defaultCategory", "handlingDays", "importAsActive", "lastOrderSyncAt", "lastOrderSyncError", "orderSyncEnabled", "orderSyncMinutes", "productLocation", "sellerId", "sellerToken", "shop", "syncTag", "updatedAt", "zeroStockOnDelete") SELECT "apiBaseUrl", "autoSyncEnabled", "createOnKogan", "currency", "defaultCategory", "handlingDays", "importAsActive", "lastOrderSyncAt", "lastOrderSyncError", "orderSyncEnabled", "orderSyncMinutes", "productLocation", "sellerId", "sellerToken", "shop", "syncTag", "updatedAt", "zeroStockOnDelete" FROM "KoganSettings";
DROP TABLE "KoganSettings";
ALTER TABLE "new_KoganSettings" RENAME TO "KoganSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
