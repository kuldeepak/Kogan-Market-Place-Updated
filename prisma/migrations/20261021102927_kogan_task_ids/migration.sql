-- AlterTable
ALTER TABLE "KoganProductLink" ADD COLUMN "lastTaskId" TEXT;

-- AlterTable
ALTER TABLE "SyncLog" ADD COLUMN "taskId" TEXT;
