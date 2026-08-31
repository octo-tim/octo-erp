-- DropForeignKey
ALTER TABLE "Receivable" DROP CONSTRAINT "Receivable_documentId_fkey";

-- DropForeignKey
ALTER TABLE "Payable" DROP CONSTRAINT "Payable_documentId_fkey";

-- AlterTable
ALTER TABLE "Receivable" ADD COLUMN     "migrationDocNo" TEXT,
ALTER COLUMN "documentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Payable" ADD COLUMN     "migrationDocNo" TEXT,
ALTER COLUMN "documentId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Receivable_migrationDocNo_idx" ON "Receivable"("migrationDocNo");

-- CreateIndex
CREATE INDEX "Payable_migrationDocNo_idx" ON "Payable"("migrationDocNo");

-- AddForeignKey
ALTER TABLE "Receivable" ADD CONSTRAINT "Receivable_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SalesDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payable" ADD CONSTRAINT "Payable_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "PurchaseDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
