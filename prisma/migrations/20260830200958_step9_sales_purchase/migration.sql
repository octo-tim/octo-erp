-- CreateTable
CREATE TABLE "DocumentConversion" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceLineId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetLineId" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentConversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quotation" (
    "id" TEXT NOT NULL,
    "docNo" TEXT NOT NULL,
    "docDate" DATE NOT NULL,
    "validUntil" DATE,
    "partnerId" TEXT NOT NULL,
    "divisionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "title" TEXT,
    "note" TEXT,
    "supplyAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "policyVersionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotationLine" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "taxType" TEXT NOT NULL DEFAULT 'TAXABLE',
    "supplyAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,

    CONSTRAINT "QuotationLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrder" (
    "id" TEXT NOT NULL,
    "docNo" TEXT NOT NULL,
    "docDate" DATE NOT NULL,
    "deliveryDate" DATE,
    "partnerId" TEXT NOT NULL,
    "divisionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "supplyAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "policyVersionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "taxType" TEXT NOT NULL DEFAULT 'TAXABLE',
    "supplyAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,

    CONSTRAINT "SalesOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDocument" (
    "id" TEXT NOT NULL,
    "docNo" TEXT NOT NULL,
    "docType" TEXT NOT NULL DEFAULT 'SALES',
    "docDate" DATE NOT NULL,
    "partnerId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "divisionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "supplyAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "originalId" TEXT,
    "policyVersionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "canceledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDocumentLine" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "taxType" TEXT NOT NULL DEFAULT 'TAXABLE',
    "supplyAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "originalLineId" TEXT,

    CONSTRAINT "SalesDocumentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequest" (
    "id" TEXT NOT NULL,
    "docNo" TEXT NOT NULL,
    "docDate" DATE NOT NULL,
    "requiredDate" DATE,
    "divisionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "purpose" TEXT,
    "note" TEXT,
    "supplyAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "approvedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequestLine" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "taxType" TEXT NOT NULL DEFAULT 'TAXABLE',
    "supplyAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "suggestedSupplierId" TEXT,

    CONSTRAINT "PurchaseRequestLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "docNo" TEXT NOT NULL,
    "docDate" DATE NOT NULL,
    "dueDate" DATE,
    "partnerId" TEXT NOT NULL,
    "divisionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "supplyAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "policyVersionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "taxType" TEXT NOT NULL DEFAULT 'TAXABLE',
    "supplyAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseDocument" (
    "id" TEXT NOT NULL,
    "docNo" TEXT NOT NULL,
    "docType" TEXT NOT NULL DEFAULT 'PURCHASE',
    "docDate" DATE NOT NULL,
    "partnerId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "divisionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "supplyAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "originalId" TEXT,
    "policyVersionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "canceledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseDocumentLine" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "taxType" TEXT NOT NULL DEFAULT 'TAXABLE',
    "supplyAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "originalLineId" TEXT,

    CONSTRAINT "PurchaseDocumentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receivable" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "docDate" DATE NOT NULL,
    "dueDate" DATE,
    "amount" DECIMAL(18,0) NOT NULL,
    "settledAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Receivable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payable" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "docDate" DATE NOT NULL,
    "dueDate" DATE,
    "amount" DECIMAL(18,0) NOT NULL,
    "settledAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "docNo" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "docDate" DATE NOT NULL,
    "partnerId" TEXT NOT NULL,
    "method" TEXT,
    "bankAccount" TEXT,
    "amount" DECIMAL(18,0) NOT NULL,
    "allocatedAmount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "confirmedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementMatch" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "receivableId" TEXT,
    "payableId" TEXT,
    "amount" DECIMAL(18,0) NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'AUTO',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxDocumentOutput" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "attachmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'GENERATED',
    "recipientEmail" TEXT,
    "sentAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxDocumentOutput_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentConversion_targetLineId_key" ON "DocumentConversion"("targetLineId");

-- CreateIndex
CREATE INDEX "DocumentConversion_sourceType_sourceId_idx" ON "DocumentConversion"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "DocumentConversion_sourceLineId_canceledAt_idx" ON "DocumentConversion"("sourceLineId", "canceledAt");

-- CreateIndex
CREATE INDEX "DocumentConversion_targetType_targetId_idx" ON "DocumentConversion"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "Quotation_docNo_key" ON "Quotation"("docNo");

-- CreateIndex
CREATE INDEX "Quotation_partnerId_docDate_idx" ON "Quotation"("partnerId", "docDate");

-- CreateIndex
CREATE INDEX "Quotation_status_docDate_idx" ON "Quotation"("status", "docDate");

-- CreateIndex
CREATE INDEX "QuotationLine_itemId_idx" ON "QuotationLine"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "QuotationLine_quotationId_lineNo_key" ON "QuotationLine"("quotationId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_docNo_key" ON "SalesOrder"("docNo");

-- CreateIndex
CREATE INDEX "SalesOrder_partnerId_docDate_idx" ON "SalesOrder"("partnerId", "docDate");

-- CreateIndex
CREATE INDEX "SalesOrder_status_deliveryDate_idx" ON "SalesOrder"("status", "deliveryDate");

-- CreateIndex
CREATE INDEX "SalesOrderLine_itemId_idx" ON "SalesOrderLine"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderLine_orderId_lineNo_key" ON "SalesOrderLine"("orderId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDocument_docNo_key" ON "SalesDocument"("docNo");

-- CreateIndex
CREATE INDEX "SalesDocument_partnerId_docDate_idx" ON "SalesDocument"("partnerId", "docDate");

-- CreateIndex
CREATE INDEX "SalesDocument_status_docDate_idx" ON "SalesDocument"("status", "docDate");

-- CreateIndex
CREATE INDEX "SalesDocument_docType_docDate_idx" ON "SalesDocument"("docType", "docDate");

-- CreateIndex
CREATE INDEX "SalesDocumentLine_itemId_idx" ON "SalesDocumentLine"("itemId");

-- CreateIndex
CREATE INDEX "SalesDocumentLine_originalLineId_idx" ON "SalesDocumentLine"("originalLineId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDocumentLine_documentId_lineNo_key" ON "SalesDocumentLine"("documentId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequest_docNo_key" ON "PurchaseRequest"("docNo");

-- CreateIndex
CREATE INDEX "PurchaseRequest_status_docDate_idx" ON "PurchaseRequest"("status", "docDate");

-- CreateIndex
CREATE INDEX "PurchaseRequestLine_itemId_idx" ON "PurchaseRequestLine"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseRequestLine_requestId_lineNo_key" ON "PurchaseRequestLine"("requestId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_docNo_key" ON "PurchaseOrder"("docNo");

-- CreateIndex
CREATE INDEX "PurchaseOrder_partnerId_docDate_idx" ON "PurchaseOrder"("partnerId", "docDate");

-- CreateIndex
CREATE INDEX "PurchaseOrder_status_dueDate_idx" ON "PurchaseOrder"("status", "dueDate");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_itemId_idx" ON "PurchaseOrderLine"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_orderId_lineNo_key" ON "PurchaseOrderLine"("orderId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseDocument_docNo_key" ON "PurchaseDocument"("docNo");

-- CreateIndex
CREATE INDEX "PurchaseDocument_partnerId_docDate_idx" ON "PurchaseDocument"("partnerId", "docDate");

-- CreateIndex
CREATE INDEX "PurchaseDocument_status_docDate_idx" ON "PurchaseDocument"("status", "docDate");

-- CreateIndex
CREATE INDEX "PurchaseDocument_docType_docDate_idx" ON "PurchaseDocument"("docType", "docDate");

-- CreateIndex
CREATE INDEX "PurchaseDocumentLine_itemId_idx" ON "PurchaseDocumentLine"("itemId");

-- CreateIndex
CREATE INDEX "PurchaseDocumentLine_originalLineId_idx" ON "PurchaseDocumentLine"("originalLineId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseDocumentLine_documentId_lineNo_key" ON "PurchaseDocumentLine"("documentId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "Receivable_documentId_key" ON "Receivable"("documentId");

-- CreateIndex
CREATE INDEX "Receivable_partnerId_status_idx" ON "Receivable"("partnerId", "status");

-- CreateIndex
CREATE INDEX "Receivable_docDate_idx" ON "Receivable"("docDate");

-- CreateIndex
CREATE UNIQUE INDEX "Payable_documentId_key" ON "Payable"("documentId");

-- CreateIndex
CREATE INDEX "Payable_partnerId_status_idx" ON "Payable"("partnerId", "status");

-- CreateIndex
CREATE INDEX "Payable_docDate_idx" ON "Payable"("docDate");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_docNo_key" ON "Settlement"("docNo");

-- CreateIndex
CREATE INDEX "Settlement_partnerId_docDate_idx" ON "Settlement"("partnerId", "docDate");

-- CreateIndex
CREATE INDEX "Settlement_status_docDate_idx" ON "Settlement"("status", "docDate");

-- CreateIndex
CREATE INDEX "SettlementMatch_settlementId_idx" ON "SettlementMatch"("settlementId");

-- CreateIndex
CREATE INDEX "SettlementMatch_receivableId_idx" ON "SettlementMatch"("receivableId");

-- CreateIndex
CREATE INDEX "SettlementMatch_payableId_idx" ON "SettlementMatch"("payableId");

-- CreateIndex
CREATE INDEX "TaxDocumentOutput_documentId_createdAt_idx" ON "TaxDocumentOutput"("documentId", "createdAt");

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotationLine" ADD CONSTRAINT "QuotationLine_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotationLine" ADD CONSTRAINT "QuotationLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocument" ADD CONSTRAINT "SalesDocument_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocument" ADD CONSTRAINT "SalesDocument_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocument" ADD CONSTRAINT "SalesDocument_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocument" ADD CONSTRAINT "SalesDocument_originalId_fkey" FOREIGN KEY ("originalId") REFERENCES "SalesDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocumentLine" ADD CONSTRAINT "SalesDocumentLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SalesDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDocumentLine" ADD CONSTRAINT "SalesDocumentLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequestLine" ADD CONSTRAINT "PurchaseRequestLine_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PurchaseRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRequestLine" ADD CONSTRAINT "PurchaseRequestLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseDocument" ADD CONSTRAINT "PurchaseDocument_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseDocument" ADD CONSTRAINT "PurchaseDocument_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseDocument" ADD CONSTRAINT "PurchaseDocument_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseDocument" ADD CONSTRAINT "PurchaseDocument_originalId_fkey" FOREIGN KEY ("originalId") REFERENCES "PurchaseDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseDocumentLine" ADD CONSTRAINT "PurchaseDocumentLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "PurchaseDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseDocumentLine" ADD CONSTRAINT "PurchaseDocumentLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receivable" ADD CONSTRAINT "Receivable_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SalesDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receivable" ADD CONSTRAINT "Receivable_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payable" ADD CONSTRAINT "Payable_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "PurchaseDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payable" ADD CONSTRAINT "Payable_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementMatch" ADD CONSTRAINT "SettlementMatch_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementMatch" ADD CONSTRAINT "SettlementMatch_receivableId_fkey" FOREIGN KEY ("receivableId") REFERENCES "Receivable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementMatch" ADD CONSTRAINT "SettlementMatch_payableId_fkey" FOREIGN KEY ("payableId") REFERENCES "Payable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxDocumentOutput" ADD CONSTRAINT "TaxDocumentOutput_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SalesDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
