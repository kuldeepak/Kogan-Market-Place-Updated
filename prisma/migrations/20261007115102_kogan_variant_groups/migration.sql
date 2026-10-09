-- AlterTable
ALTER TABLE "KoganProductLink" ADD COLUMN "koganGroupId" TEXT;

-- CreateIndex
CREATE INDEX "KoganProductLink_shop_koganGroupId_idx" ON "KoganProductLink"("shop", "koganGroupId");
