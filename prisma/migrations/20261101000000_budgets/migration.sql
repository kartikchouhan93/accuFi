-- Budgets (M5 design §5): Budget is a monthly spending cap on one expense ledger, held as a span of calendar months.
-- Edited by hand after `prisma migrate dev --create-only`: (1) Prisma's generated "ALTER COLUMN createdAt SET DEFAULT
-- now()" statements for the pre-existing tables are removed (they were already `now()` and are no-ops, produced because
-- Prisma reads dbgenerated("now()") as drift), and (2) the CHECK constraints and the updatedAt trigger below are
-- appended, which Prisma cannot model. Both foreign keys are RESTRICT, like every other foreign key here.

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "startMonth" DATE NOT NULL,
    "endMonth" DATE,
    "rollover" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Budget_userId_nodeId_startMonth_idx" ON "Budget"("userId", "nodeId", "startMonth");

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "LedgerNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A budget that could never be evaluated is rejected whatever the application does. amountPaise is paise, so "> 0" rules
-- out a free cap; a month is stored as the DATE of its first day; endMonth is the first day of the last month the budget
-- applies to, so it is null (open-ended) or a first-of-month on or after the start. A DATE has no time part, so
-- EXTRACT(DAY ...) = 1 is the whole test. A NULL endMonth passes the last check by SQL's rule that a CHECK only fails on
-- FALSE, but the IS NULL branch says so out loud.
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_amountPaise_positive" CHECK ("amountPaise" > 0);
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_startMonth_first_of_month" CHECK (EXTRACT(DAY FROM "startMonth") = 1);
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_endMonth_first_of_month_not_before_start" CHECK (
  "endMonth" IS NULL OR (EXTRACT(DAY FROM "endMonth") = 1 AND "endMonth" >= "startMonth")
);

-- EC-66: Budget.updatedAt comes from the database clock, exactly like Transaction.updatedAt. Prisma's `@updatedAt`
-- supplies the app process's clock on create and update, so only a trigger can overwrite it. This reuses set_updated_at()
-- from 20261019230000_updated_at_trigger.
CREATE TRIGGER "Budget_set_updated_at"
BEFORE INSERT OR UPDATE ON "Budget"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
