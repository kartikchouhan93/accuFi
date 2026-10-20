-- Corrects 20261020184537_investments, which made LotConsumption.costBasisPaise strictly positive. The lot allocator
-- legitimately yields a zero-paisa basis for a tiny partial take (1 of 3 units of a lot that cost 1 paisa rounds to 0),
-- and that output is persisted as is, so a "> 0" check would make such a sale fail at write time. A negative basis is
-- still impossible. The constraint is renamed so its name says what it enforces. InvestmentLot.costBasisPaise stays > 0.
ALTER TABLE "LotConsumption" DROP CONSTRAINT "LotConsumption_costBasisPaise_positive";
ALTER TABLE "LotConsumption" ADD CONSTRAINT "LotConsumption_costBasisPaise_nonnegative" CHECK ("costBasisPaise" >= 0);
