/*
  Warnings:

  - You are about to drop the `HealthCheck` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "LedgerKind" AS ENUM ('INCOME_SOURCE', 'ASSET', 'INVESTMENT', 'EXPENSE', 'LIABILITY');

-- CreateEnum
CREATE TYPE "AssetSubtype" AS ENUM ('SAVINGS', 'CURRENT', 'CASH', 'WALLET');

-- CreateEnum
CREATE TYPE "LiabilitySubtype" AS ENUM ('CREDIT_CARD', 'LOAN');

-- CreateEnum
CREATE TYPE "ValuationMode" AS ENUM ('QUANTITY', 'LUMP', 'CONTRIBUTION_ONLY');

-- CreateEnum
CREATE TYPE "LotMethod" AS ENUM ('FIFO', 'LIFO', 'HIGHEST_COST_FIRST');

-- CreateEnum
CREATE TYPE "SystemNodeRole" AS ENUM ('OPENING_BALANCE', 'REALISED_GAIN', 'REALISED_LOSS');

-- CreateEnum
CREATE TYPE "GroupKind" AS ENUM ('MANUAL_SPLIT', 'DISPOSAL', 'EMI');

-- DropTable
DROP TABLE "HealthCheck";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "financialYearStartMonth" INTEGER NOT NULL DEFAULT 4,
    "stalePriceDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerNode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "LedgerKind" NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "institution" TEXT,
    "lastFour" TEXT,
    "assetSubtype" "AssetSubtype",
    "liabilitySubtype" "LiabilitySubtype",
    "creditLimitPaise" BIGINT,
    "statementDay" INTEGER,
    "dueDay" INTEGER,
    "valuationMode" "ValuationMode",
    "unitLabel" TEXT,
    "lotMethod" "LotMethod",
    "stalePriceDays" INTEGER,
    "blockNegative" BOOLEAN NOT NULL DEFAULT false,
    "systemRole" "SystemNodeRole",
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "LedgerNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionGroup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "GroupKind" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "TransactionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "occurredAt" DATE NOT NULL,
    "note" TEXT,
    "tags" TEXT[],
    "groupId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "LedgerNode_userId_kind_idx" ON "LedgerNode"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerNode_userId_systemRole_key" ON "LedgerNode"("userId", "systemRole");

-- CreateIndex
CREATE INDEX "Transaction_userId_toNodeId_occurredAt_idx" ON "Transaction"("userId", "toNodeId", "occurredAt");

-- CreateIndex
CREATE INDEX "Transaction_userId_fromNodeId_occurredAt_idx" ON "Transaction"("userId", "fromNodeId", "occurredAt");

-- CreateIndex
CREATE INDEX "Transaction_userId_occurredAt_idx" ON "Transaction"("userId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_userId_idempotencyKey_key" ON "Transaction"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "LedgerNode" ADD CONSTRAINT "LedgerNode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerNode" ADD CONSTRAINT "LedgerNode_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "LedgerNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionGroup" ADD CONSTRAINT "TransactionGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_fromNodeId_fkey" FOREIGN KEY ("fromNodeId") REFERENCES "LedgerNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_toNodeId_fkey" FOREIGN KEY ("toNodeId") REFERENCES "LedgerNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TransactionGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
