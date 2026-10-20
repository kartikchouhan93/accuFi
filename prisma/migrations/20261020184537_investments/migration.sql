-- M2 investments: lots, the consumptions that draw them down, and price snapshots (spec §7.2, §7.3, §7.5).
-- Prisma generated the tables, indexes and foreign keys. Hand-edited: removed the no-op "ALTER COLUMN ... SET DEFAULT
-- now()" statements Prisma re-emits for existing tables (those defaults are already now(); it is a quirk of
-- dbgenerated("now()")), and added the CHECK constraints and the updatedAt trigger below, which Prisma cannot model.
-- There is no remaining-quantity column on InvestmentLot on purpose: remaining is derived (spec §9.4).

-- CreateEnum
CREATE TYPE "PriceSource" AS ENUM ('MANUAL', 'FEED');

-- CreateTable
CREATE TABLE "InvestmentLot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "costBasisPaise" BIGINT NOT NULL,
    "acquiredAt" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "InvestmentLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LotConsumption" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "costBasisPaise" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "LotConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "pricePerUnitPaise" BIGINT NOT NULL,
    "source" "PriceSource" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "PriceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvestmentLot_transactionId_key" ON "InvestmentLot"("transactionId");

-- CreateIndex
CREATE INDEX "InvestmentLot_userId_nodeId_acquiredAt_idx" ON "InvestmentLot"("userId", "nodeId", "acquiredAt");

-- CreateIndex
CREATE INDEX "LotConsumption_userId_transactionId_idx" ON "LotConsumption"("userId", "transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "LotConsumption_lotId_transactionId_key" ON "LotConsumption"("lotId", "transactionId");

-- CreateIndex
CREATE INDEX "PriceSnapshot_userId_nodeId_asOf_idx" ON "PriceSnapshot"("userId", "nodeId", "asOf");

-- CreateIndex
CREATE UNIQUE INDEX "PriceSnapshot_nodeId_asOf_key" ON "PriceSnapshot"("nodeId", "asOf");

-- AddForeignKey
ALTER TABLE "InvestmentLot" ADD CONSTRAINT "InvestmentLot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentLot" ADD CONSTRAINT "InvestmentLot_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "LedgerNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentLot" ADD CONSTRAINT "InvestmentLot_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotConsumption" ADD CONSTRAINT "LotConsumption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotConsumption" ADD CONSTRAINT "LotConsumption_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "InvestmentLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotConsumption" ADD CONSTRAINT "LotConsumption_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceSnapshot" ADD CONSTRAINT "PriceSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceSnapshot" ADD CONSTRAINT "PriceSnapshot_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "LedgerNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A lot, a consumption or a price of zero or less is never meaningful and is rejected whatever the application does.
-- Money columns are paise, so "> 0" also rules out a free lot (quantity and cost are both authoritative figures).
ALTER TABLE "InvestmentLot" ADD CONSTRAINT "InvestmentLot_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "InvestmentLot" ADD CONSTRAINT "InvestmentLot_costBasisPaise_positive" CHECK ("costBasisPaise" > 0);
ALTER TABLE "LotConsumption" ADD CONSTRAINT "LotConsumption_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "LotConsumption" ADD CONSTRAINT "LotConsumption_costBasisPaise_positive" CHECK ("costBasisPaise" > 0);
ALTER TABLE "PriceSnapshot" ADD CONSTRAINT "PriceSnapshot_pricePerUnitPaise_positive" CHECK ("pricePerUnitPaise" > 0);

-- EC-66: PriceSnapshot.updatedAt comes from the database clock, exactly like Transaction.updatedAt. Prisma's
-- `@updatedAt` supplies the app process's clock on create and update, so only a trigger can overwrite it. This reuses
-- set_updated_at() from 20261019230000_updated_at_trigger; re-entering a day's price is an UPDATE and must bump it.
CREATE TRIGGER "PriceSnapshot_set_updated_at"
BEFORE INSERT OR UPDATE ON "PriceSnapshot"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
