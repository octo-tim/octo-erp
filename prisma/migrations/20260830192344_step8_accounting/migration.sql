-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "normalSide" TEXT NOT NULL,
    "parentId" TEXT,
    "level" INTEGER NOT NULL DEFAULT 1,
    "isPostable" BOOLEAN NOT NULL DEFAULT true,
    "isStandard" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountMapping" (
    "id" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingPeriod" (
    "id" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenedById" TEXT,
    "reopenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "entryNo" TEXT NOT NULL,
    "entryType" TEXT NOT NULL DEFAULT 'TRANSFER',
    "entryDate" DATE NOT NULL,
    "periodId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "description" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "sourceVersion" INTEGER NOT NULL DEFAULT 1,
    "postingRuleVersionId" TEXT,
    "reversalOfId" TEXT,
    "totalDebit" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "totalCredit" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "isClosingEntry" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "canceledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "description" TEXT,
    "divisionId" TEXT,
    "partnerId" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostingRule" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostingRuleVersion" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "template" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostingRuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpeningBalance" (
    "id" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "divisionId" TEXT,
    "debit" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "origin" TEXT NOT NULL DEFAULT 'CARRY_FORWARD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpeningBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClosingRun" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MONTH',
    "closingEntryId" TEXT,
    "entriesLocked" INTEGER NOT NULL DEFAULT 0,
    "carriedAccounts" INTEGER NOT NULL DEFAULT 0,
    "runById" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClosingRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_code_key" ON "Account"("code");

-- CreateIndex
CREATE INDEX "Account_accountType_code_idx" ON "Account"("accountType", "code");

-- CreateIndex
CREATE INDEX "Account_parentId_idx" ON "Account"("parentId");

-- CreateIndex
CREATE INDEX "Account_isActive_idx" ON "Account"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AccountMapping_slot_key" ON "AccountMapping"("slot");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingPeriod_periodKey_key" ON "AccountingPeriod"("periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_entryNo_key" ON "JournalEntry"("entryNo");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversalOfId_key" ON "JournalEntry"("reversalOfId");

-- CreateIndex
CREATE INDEX "JournalEntry_entryDate_status_idx" ON "JournalEntry"("entryDate", "status");

-- CreateIndex
CREATE INDEX "JournalEntry_periodId_status_idx" ON "JournalEntry"("periodId", "status");

-- CreateIndex
CREATE INDEX "JournalEntry_sourceType_sourceId_idx" ON "JournalEntry"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_sourceType_sourceId_sourceVersion_key" ON "JournalEntry"("sourceType", "sourceId", "sourceVersion");

-- CreateIndex
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");

-- CreateIndex
CREATE INDEX "JournalLine_divisionId_idx" ON "JournalLine"("divisionId");

-- CreateIndex
CREATE INDEX "JournalLine_partnerId_idx" ON "JournalLine"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalLine_entryId_lineNo_key" ON "JournalLine"("entryId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "PostingRule_code_key" ON "PostingRule"("code");

-- CreateIndex
CREATE INDEX "PostingRuleVersion_ruleId_effectiveFrom_idx" ON "PostingRuleVersion"("ruleId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PostingRuleVersion_ruleId_version_key" ON "PostingRuleVersion"("ruleId", "version");

-- CreateIndex
CREATE INDEX "OpeningBalance_accountId_idx" ON "OpeningBalance"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "OpeningBalance_periodKey_accountId_divisionId_key" ON "OpeningBalance"("periodKey", "accountId", "divisionId");

-- CreateIndex
CREATE INDEX "ClosingRun_periodId_runAt_idx" ON "ClosingRun"("periodId", "runAt");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountMapping" ADD CONSTRAINT "AccountMapping_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "AccountingPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_postingRuleVersionId_fkey" FOREIGN KEY ("postingRuleVersionId") REFERENCES "PostingRuleVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "Division"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostingRuleVersion" ADD CONSTRAINT "PostingRuleVersion_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "PostingRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpeningBalance" ADD CONSTRAINT "OpeningBalance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClosingRun" ADD CONSTRAINT "ClosingRun_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "AccountingPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
