-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "anonymizedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "purgedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Attachment_ownerType_deletedAt_idx" ON "Attachment"("ownerType", "deletedAt");
