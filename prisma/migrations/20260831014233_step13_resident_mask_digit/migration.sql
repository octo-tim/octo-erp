-- AlterTable
ALTER TABLE "EmployeeSensitive" DROP COLUMN "residentNoLast4",
ADD COLUMN     "residentNoMaskDigit" TEXT;
