-- CreateTable
CREATE TABLE "StockDocument" (
    "id" TEXT NOT NULL,
    "docNo" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "docDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "movementState" TEXT,
    "fromWarehouseId" TEXT,
    "toWarehouseId" TEXT,
    "partnerId" TEXT,
    "reasonCode" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "divisionId" TEXT,
    "note" TEXT,
    "totalQuantity" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "canceledAt" TIMESTAMP(3),
    "canceledById" TEXT,
    "cancelReason" TEXT,
    "stockCountId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockDocumentLine" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unitCost" DECIMAL(18,4),
    "amount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "StockDocumentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLedger" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceLineId" TEXT,
    "sourceVersion" INTEGER NOT NULL DEFAULT 1,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unitCost" DECIMAL(18,4),
    "amount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "valuationPeriod" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockSnapshot" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL,
    "countNo" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "countDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "frozenAt" TIMESTAMP(3),
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "approvedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "systemQty" DECIMAL(18,3) NOT NULL,
    "countedQty" DECIMAL(18,3),
    "reason" TEXT,

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryValuationPeriod" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "policyVersionId" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryValuationPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryPeriodCost" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "openingQty" DECIMAL(18,3) NOT NULL,
    "openingAmount" DECIMAL(18,0) NOT NULL,
    "inQty" DECIMAL(18,3) NOT NULL,
    "inAmount" DECIMAL(18,0) NOT NULL,
    "outQty" DECIMAL(18,3) NOT NULL,
    "provisionalOutAmount" DECIMAL(18,0) NOT NULL,
    "averageCost" DECIMAL(18,4) NOT NULL,
    "finalOutAmount" DECIMAL(18,0) NOT NULL,
    "adjustment" DECIMAL(18,0) NOT NULL,
    "closingQty" DECIMAL(18,3) NOT NULL,
    "closingAmount" DECIMAL(18,0) NOT NULL,

    CONSTRAINT "InventoryPeriodCost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockDocument_docNo_key" ON "StockDocument"("docNo");

-- CreateIndex
CREATE UNIQUE INDEX "StockDocument_stockCountId_key" ON "StockDocument"("stockCountId");

-- CreateIndex
CREATE INDEX "StockDocument_docType_status_docDate_idx" ON "StockDocument"("docType", "status", "docDate");

-- CreateIndex
CREATE INDEX "StockDocument_docDate_idx" ON "StockDocument"("docDate");

-- CreateIndex
CREATE INDEX "StockDocument_sourceType_sourceId_idx" ON "StockDocument"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "StockDocumentLine_itemId_idx" ON "StockDocumentLine"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "StockDocumentLine_documentId_lineNo_key" ON "StockDocumentLine"("documentId", "lineNo");

-- CreateIndex
CREATE INDEX "InventoryLedger_itemId_warehouseId_occurredAt_idx" ON "InventoryLedger"("itemId", "warehouseId", "occurredAt");

-- CreateIndex
CREATE INDEX "InventoryLedger_warehouseId_occurredAt_idx" ON "InventoryLedger"("warehouseId", "occurredAt");

-- CreateIndex
CREATE INDEX "InventoryLedger_occurredAt_idx" ON "InventoryLedger"("occurredAt");

-- CreateIndex
CREATE INDEX "InventoryLedger_valuationPeriod_idx" ON "InventoryLedger"("valuationPeriod");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLedger_sourceType_sourceId_sourceLineId_sourceVers_key" ON "InventoryLedger"("sourceType", "sourceId", "sourceLineId", "sourceVersion");

-- CreateIndex
CREATE INDEX "StockSnapshot_warehouseId_idx" ON "StockSnapshot"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "StockSnapshot_itemId_warehouseId_key" ON "StockSnapshot"("itemId", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_countNo_key" ON "StockCount"("countNo");

-- CreateIndex
CREATE INDEX "StockCount_warehouseId_countDate_idx" ON "StockCount"("warehouseId", "countDate");

-- CreateIndex
CREATE INDEX "StockCountLine_itemId_idx" ON "StockCountLine"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_countId_itemId_key" ON "StockCountLine"("countId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryValuationPeriod_period_key" ON "InventoryValuationPeriod"("period");

-- CreateIndex
CREATE INDEX "InventoryPeriodCost_itemId_idx" ON "InventoryPeriodCost"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPeriodCost_periodId_itemId_key" ON "InventoryPeriodCost"("periodId", "itemId");

-- AddForeignKey
ALTER TABLE "StockDocument" ADD CONSTRAINT "StockDocument_fromWarehouseId_fkey" FOREIGN KEY ("fromWarehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDocument" ADD CONSTRAINT "StockDocument_toWarehouseId_fkey" FOREIGN KEY ("toWarehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDocument" ADD CONSTRAINT "StockDocument_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDocument" ADD CONSTRAINT "StockDocument_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDocument" ADD CONSTRAINT "StockDocument_stockCountId_fkey" FOREIGN KEY ("stockCountId") REFERENCES "StockCount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDocumentLine" ADD CONSTRAINT "StockDocumentLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "StockDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockDocumentLine" ADD CONSTRAINT "StockDocumentLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedger" ADD CONSTRAINT "InventoryLedger_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedger" ADD CONSTRAINT "InventoryLedger_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockSnapshot" ADD CONSTRAINT "StockSnapshot_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockSnapshot" ADD CONSTRAINT "StockSnapshot_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPeriodCost" ADD CONSTRAINT "InventoryPeriodCost_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "InventoryValuationPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPeriodCost" ADD CONSTRAINT "InventoryPeriodCost_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
