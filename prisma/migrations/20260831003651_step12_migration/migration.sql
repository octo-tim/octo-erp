-- CreateTable
CREATE TABLE "MigrationBatch" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL DEFAULT 1,
    "fileName" TEXT,
    "baselineDate" DATE,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "appliedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'VALIDATED',
    "errors" JSONB,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "MigrationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "rowNo" INTEGER NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MigrationBatch_targetType_createdAt_idx" ON "MigrationBatch"("targetType", "createdAt");

-- CreateIndex
CREATE INDEX "MigrationRow_batchId_idx" ON "MigrationRow"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationRow_targetType_sourceKey_key" ON "MigrationRow"("targetType", "sourceKey");

-- AddForeignKey
ALTER TABLE "MigrationRow" ADD CONSTRAINT "MigrationRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "MigrationBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
