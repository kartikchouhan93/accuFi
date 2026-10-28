-- Recurring entries (M4 design §5): RecurringRule is the template and schedule, RecurringOccurrence one due date of it.
-- Edited by hand after `prisma migrate dev --create-only`: (1) Prisma's generated "ALTER COLUMN createdAt SET DEFAULT
-- now()" statements for the pre-existing tables are removed (they were already `now()` and are no-ops, produced because
-- Prisma reads dbgenerated("now()") as drift), (2) the occurrence -> transaction foreign key is RESTRICT, like every
-- other foreign key here, instead of Prisma's SET NULL default for an optional relation, and (3) the CHECK constraints
-- and the updatedAt trigger below are appended, which Prisma cannot model.

-- CreateEnum
CREATE TYPE "RecurrenceFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "OccurrenceStatus" AS ENUM ('PENDING', 'POSTED', 'DISMISSED');

-- CreateTable
CREATE TABLE "RecurringRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "note" TEXT,
    "tags" TEXT[],
    "frequency" "RecurrenceFrequency" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "dayOfMonth" INTEGER,
    "dayOfWeek" INTEGER,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "occurrenceLimit" INTEGER,
    "autoPost" BOOLEAN NOT NULL DEFAULT false,
    "nextDueOn" DATE,
    "pausedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "RecurringRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringOccurrence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "dueOn" DATE NOT NULL,
    "status" "OccurrenceStatus" NOT NULL DEFAULT 'PENDING',
    "transactionId" TEXT,
    "postFailure" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "RecurringOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringRule_userId_nextDueOn_idx" ON "RecurringRule"("userId", "nextDueOn");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringRule_userId_idempotencyKey_key" ON "RecurringRule"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringOccurrence_transactionId_key" ON "RecurringOccurrence"("transactionId");

-- CreateIndex
CREATE INDEX "RecurringOccurrence_userId_status_dueOn_idx" ON "RecurringOccurrence"("userId", "status", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringOccurrence_ruleId_dueOn_key" ON "RecurringOccurrence"("ruleId", "dueOn");

-- AddForeignKey
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_fromNodeId_fkey" FOREIGN KEY ("fromNodeId") REFERENCES "LedgerNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_toNodeId_fkey" FOREIGN KEY ("toNodeId") REFERENCES "LedgerNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringOccurrence" ADD CONSTRAINT "RecurringOccurrence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringOccurrence" ADD CONSTRAINT "RecurringOccurrence_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RecurringRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringOccurrence" ADD CONSTRAINT "RecurringOccurrence_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A rule that could never produce a sensible schedule or entry is rejected whatever the application does.
-- interval counts frequency units, so it is at least 1; dayOfMonth is 1-31 (31 means "the last day", clamped by the
-- domain); dayOfWeek is ISO 1 (Monday) to 7 (Sunday); amountPaise is paise, so "> 0" rules out a free entry; an
-- occurrenceLimit of zero would end the schedule before it began.
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_interval_positive" CHECK ("interval" >= 1);
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_dayOfMonth_range" CHECK ("dayOfMonth" IS NULL OR "dayOfMonth" BETWEEN 1 AND 31);
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_dayOfWeek_range" CHECK ("dayOfWeek" IS NULL OR "dayOfWeek" BETWEEN 1 AND 7);
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_amountPaise_positive" CHECK ("amountPaise" > 0);
ALTER TABLE "RecurringRule" ADD CONSTRAINT "RecurringRule_occurrenceLimit_positive" CHECK ("occurrenceLimit" IS NULL OR "occurrenceLimit" >= 1);

-- EC-66: RecurringRule.updatedAt comes from the database clock, exactly like Transaction.updatedAt. Prisma's `@updatedAt`
-- supplies the app process's clock on create and update, so only a trigger can overwrite it. This reuses set_updated_at()
-- from 20261019230000_updated_at_trigger.
CREATE TRIGGER "RecurringRule_set_updated_at"
BEFORE INSERT OR UPDATE ON "RecurringRule"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
