-- AlterTable
ALTER TABLE "KoganProductLink" ADD COLUMN "koganCategory" TEXT;

-- CreateTable
CREATE TABLE "KoganCategory" (
    "source" TEXT NOT NULL,
    "id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "departments" TEXT NOT NULL DEFAULT '[]',
    "url" TEXT,
    "parentId" INTEGER,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("source", "id")
);

-- CreateTable
CREATE TABLE "KoganCategorySync" (
    "source" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "count" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" DATETIME,
    "error" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "KoganCategory_source_slug_idx" ON "KoganCategory"("source", "slug");

-- CreateIndex
CREATE INDEX "KoganCategory_source_title_idx" ON "KoganCategory"("source", "title");

-- CreateIndex
CREATE INDEX "KoganProductLink_shop_koganCategory_idx" ON "KoganProductLink"("shop", "koganCategory");

-- Backfill the category of products that were linked before this column existed.
UPDATE "KoganProductLink"
SET "koganCategory" = NULLIF(TRIM(json_extract("snapshot", '$.category')), '')
WHERE "snapshot" IS NOT NULL
  AND json_valid("snapshot")
  AND json_type("snapshot", '$.category') = 'text';
