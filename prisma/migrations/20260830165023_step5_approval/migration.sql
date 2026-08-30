-- CreateTable
CREATE TABLE "ApprovalForm" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "targetType" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalFormVersion" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fieldSchema" JSONB NOT NULL,
    "bodyTemplate" TEXT,
    "defaultLineTemplateId" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalFormVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalLineTemplate" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "editable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalLineTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalLineTemplateStep" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "stepNo" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'APPROVE',
    "resolveBy" TEXT NOT NULL DEFAULT 'USER',
    "userId" TEXT,
    "positionCode" TEXT,
    "departmentId" TEXT,
    "minAmount" DECIMAL(18,0),
    "canFinalize" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ApprovalLineTemplateStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRule" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "formId" TEXT,
    "divisionId" TEXT,
    "departmentId" TEXT,
    "minAmount" DECIMAL(18,0),
    "maxAmount" DECIMAL(18,0),
    "lineTemplateId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delegation" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE NOT NULL,
    "reason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Delegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalDocument" (
    "id" TEXT NOT NULL,
    "docNo" TEXT NOT NULL,
    "formVersionId" TEXT NOT NULL,
    "formSnapshot" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "drafterId" TEXT NOT NULL,
    "drafterEmployeeId" TEXT,
    "divisionId" TEXT,
    "departmentId" TEXT,
    "amount" DECIMAL(18,0),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currentStepNo" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "policyVersionId" TEXT,
    "cancelsDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalStep" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "stepNo" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'APPROVE',
    "approverId" TEXT NOT NULL,
    "actedByUserId" TEXT,
    "canFinalize" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "comment" TEXT,
    "actedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalParticipant" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'REFERENCE',
    "readAt" TIMESTAMP(3),

    CONSTRAINT "ApprovalParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalActionLog" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "stepNo" INTEGER,
    "actorId" TEXT NOT NULL,
    "actedByUserId" TEXT,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalLink" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalForm_code_key" ON "ApprovalForm"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalFormVersion_formId_version_key" ON "ApprovalFormVersion"("formId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalLineTemplate_code_key" ON "ApprovalLineTemplate"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalLineTemplateStep_templateId_stepNo_key" ON "ApprovalLineTemplateStep"("templateId", "stepNo");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRule_code_key" ON "ApprovalRule"("code");

-- CreateIndex
CREATE INDEX "Delegation_fromUserId_validFrom_validTo_idx" ON "Delegation"("fromUserId", "validFrom", "validTo");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalDocument_docNo_key" ON "ApprovalDocument"("docNo");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalDocument_cancelsDocumentId_key" ON "ApprovalDocument"("cancelsDocumentId");

-- CreateIndex
CREATE INDEX "ApprovalDocument_status_currentStepNo_idx" ON "ApprovalDocument"("status", "currentStepNo");

-- CreateIndex
CREATE INDEX "ApprovalDocument_drafterId_createdAt_idx" ON "ApprovalDocument"("drafterId", "createdAt");

-- CreateIndex
CREATE INDEX "ApprovalStep_approverId_status_idx" ON "ApprovalStep"("approverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalStep_documentId_stepNo_key" ON "ApprovalStep"("documentId", "stepNo");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalParticipant_documentId_userId_role_key" ON "ApprovalParticipant"("documentId", "userId", "role");

-- CreateIndex
CREATE INDEX "ApprovalActionLog_documentId_createdAt_idx" ON "ApprovalActionLog"("documentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalActionLog_documentId_stepNo_action_requestId_key" ON "ApprovalActionLog"("documentId", "stepNo", "action", "requestId");

-- CreateIndex
CREATE INDEX "ApprovalLink_documentId_idx" ON "ApprovalLink"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalLink_targetType_targetId_targetVersion_key" ON "ApprovalLink"("targetType", "targetId", "targetVersion");

-- AddForeignKey
ALTER TABLE "ApprovalFormVersion" ADD CONSTRAINT "ApprovalFormVersion_formId_fkey" FOREIGN KEY ("formId") REFERENCES "ApprovalForm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalLineTemplateStep" ADD CONSTRAINT "ApprovalLineTemplateStep_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ApprovalLineTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDocument" ADD CONSTRAINT "ApprovalDocument_formVersionId_fkey" FOREIGN KEY ("formVersionId") REFERENCES "ApprovalFormVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ApprovalDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalParticipant" ADD CONSTRAINT "ApprovalParticipant_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ApprovalDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalActionLog" ADD CONSTRAINT "ApprovalActionLog_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ApprovalDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalLink" ADD CONSTRAINT "ApprovalLink_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ApprovalDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
