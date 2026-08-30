-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "dedupKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupKey_key" ON "Notification"("userId", "dedupKey");
