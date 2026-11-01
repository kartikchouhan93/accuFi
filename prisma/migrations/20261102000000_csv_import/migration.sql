-- CSV import (M6 design §5): ImportProfile (a saved mapping), ImportBatch (one uploaded statement), ImportRow (one staged
-- line), CounterpartRule (a suggestion learned from commits), and two nullable columns on Transaction that say which
-- batch and row created it.
-- Generated with `prisma migrate diff` between the previous schema and this one (`migrate dev --create-only` needs a
-- terminal), then edited by hand: the CHECK constraints and the updatedAt triggers at the end are appended, which Prisma
-- cannot model. No "ALTER COLUMN createdAt SET DEFAULT now()" statements were produced for the existing tables.
-- Every foreign key is RESTRICT, as elsewhere, except ImportBatch.profileId (SET NULL: deleting a saved mapping must not
-- be blocked by the history of imports made with it). ImportRow.occurrenceId and ImportRow.duplicateOfTransactionId are
-- deliberately plain columns with NO foreign key: a pending recurring occurrence is hard-deleted with its rule, so a
-- RESTRICT key would make deleting a rule fail, and the duplicate pointer is re-validated where it is used.
-- ImportRow.transactionId and Transaction.importRowId reference each other (both nullable); a cleanup must null one side
-- before deleting transactions.

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('UPLOADED', 'STAGED', 'COMMITTED', 'REVERSED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('PENDING', 'READY', 'SKIPPED', 'ERRORED', 'COMMITTED');

-- CreateEnum
CREATE TYPE "ImportDirection" AS ENUM ('OUT', 'IN');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "importRowId" TEXT;

-- CreateTable
CREATE TABLE "ImportProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nodeId" TEXT,
    "settings" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "ImportProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "fileHash" TEXT NOT NULL,
    "fileBytes" BYTEA,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'UPLOADED',
    "mapping" JSONB,
    "profileId" TEXT,
    "rowCount" INTEGER NOT NULL,
    "committedAt" TIMESTAMPTZ(3),
    "reversedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "raw" TEXT[],
    "status" "ImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "errorReason" TEXT,
    "occurredOn" DATE,
    "amountPaise" BIGINT,
    "direction" "ImportDirection",
    "description" TEXT,
    "descriptionKey" TEXT,
    "counterpartNodeId" TEXT,
    "duplicateOfTransactionId" TEXT,
    "occurrenceId" TEXT,
    "transactionId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CounterpartRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" "ImportDirection" NOT NULL,
    "descriptionKey" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "CounterpartRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImportProfile_userId_name_key" ON "ImportProfile"("userId", "name");

-- CreateIndex
CREATE INDEX "ImportBatch_userId_fileHash_idx" ON "ImportBatch"("userId", "fileHash");

-- CreateIndex
CREATE INDEX "ImportBatch_userId_createdAt_idx" ON "ImportBatch"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_transactionId_key" ON "ImportRow"("transactionId");

-- CreateIndex
CREATE INDEX "ImportRow_userId_batchId_status_idx" ON "ImportRow"("userId", "batchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_batchId_line_key" ON "ImportRow"("batchId", "line");

-- CreateIndex
CREATE UNIQUE INDEX "CounterpartRule_userId_direction_descriptionKey_key" ON "CounterpartRule"("userId", "direction", "descriptionKey");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_importRowId_key" ON "Transaction"("importRowId");

-- CreateIndex
CREATE INDEX "Transaction_userId_importBatchId_idx" ON "Transaction"("userId", "importBatchId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_importRowId_fkey" FOREIGN KEY ("importRowId") REFERENCES "ImportRow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportProfile" ADD CONSTRAINT "ImportProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportProfile" ADD CONSTRAINT "ImportProfile_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "LedgerNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "LedgerNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ImportProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_counterpartNodeId_fkey" FOREIGN KEY ("counterpartNodeId") REFERENCES "LedgerNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CounterpartRule" ADD CONSTRAINT "CounterpartRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CounterpartRule" ADD CONSTRAINT "CounterpartRule_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "LedgerNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A batch or row that could never be processed is rejected whatever the application does. fileHash is a SHA-256 in
-- lowercase hex (64 characters); fileSize is 1 byte to 5 MiB (5242880), the upload cap; rowCount is not negative.
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_fileHash_sha256_hex" CHECK ("fileHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_fileSize_within_cap" CHECK ("fileSize" > 0 AND "fileSize" <= 5242880);
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_rowCount_nonnegative" CHECK ("rowCount" >= 0);

-- A row's line is 1-based; its amount, when parsed, is positive paise (the direction carries the sign); a READY row has
-- a counterpart; a COMMITTED row has both a transaction and a counterpart; an ERRORED row says why. "a <> b OR c" is the
-- implication "a implies c", and a NULL operand never makes a CHECK fail, so each rule's IS NOT NULL test is explicit.
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_line_positive" CHECK ("line" >= 1);
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_amountPaise_positive" CHECK ("amountPaise" IS NULL OR "amountPaise" > 0);
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_status_ready_has_counterpart" CHECK (
  "status" <> 'READY' OR "counterpartNodeId" IS NOT NULL
);
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_status_committed_has_transaction_and_counterpart" CHECK (
  "status" <> 'COMMITTED' OR ("transactionId" IS NOT NULL AND "counterpartNodeId" IS NOT NULL)
);
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_status_errored_has_reason" CHECK (
  "status" <> 'ERRORED' OR "errorReason" IS NOT NULL
);

-- EC-66: updatedAt comes from the database clock, exactly like Transaction.updatedAt. Prisma's `@updatedAt` supplies the
-- app process's clock on create and update, so only a trigger can overwrite it. This reuses set_updated_at() from
-- 20261019230000_updated_at_trigger. ImportBatch and ImportRow have no updatedAt column.
CREATE TRIGGER "ImportProfile_set_updated_at"
BEFORE INSERT OR UPDATE ON "ImportProfile"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER "CounterpartRule_set_updated_at"
BEFORE INSERT OR UPDATE ON "CounterpartRule"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
