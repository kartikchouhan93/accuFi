# AccuFi M2 — Investments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track investments with real cost basis: every purchase becomes a lot, prices are entered by hand with history, holdings are valued from the latest price, and a sale posts a FIFO disposal split that records gain or loss. Net worth uses the valuation and says so when an investment cannot be valued.

**Architecture:** Pure money rules go in `src/domain/` (quantity arithmetic, lot allocation, valuation), then three new tables behind repositories, then services that extend the transaction write path and add disposals, prices and valuation, then Server Actions and two screens (`/investments`, `/investments/prices`). Remaining quantity is **derived** from lots and consumptions, never stored (see Call 1).

**Tech Stack:** Bun, Next.js 16 App Router, Prisma 6 / PostgreSQL, Zod, Vitest (two timezone passes, `accufi_test` DB), Playwright, the existing `src/components/ui/*` primitives.

**Spec:** `docs/superpowers/specs/2026-09-11-accufi-design.md` §4, §6.2, §7, §8.2, EC-13, EC-15, EC-16, EC-19, EC-21..EC-31. Existing code to read first: `src/server/services/transaction-service.ts`, `src/server/repositories/{transaction-repository,unit-of-work}.ts`, `src/domain/{balance,calendar-date,money}.ts`, `src/lib/dashboard-view.ts`, `src/lib/node-overview.ts`.

## Global Constraints

- Money is integer paise as `bigint`; no `Number`/float arithmetic on money (EC-1). Serialised as decimal strings across the server/client boundary (`serialisePaise`).
- Quantities are `Decimal(18,6)` in Postgres and **scaled `bigint` micro-units in the domain** (1 unit = `1_000_000n`); never a JS `number` (EC-27). Gold 3 dp, mutual funds 4 dp, lump assets exactly 1; the input limit is 6 dp.
- `src/domain/` imports nothing from Prisma, Next or `src/server` (pinned by `tests/lint/domain-purity.test.ts`).
- Every repository function takes `userId` first and filters on it; every new repository gets a second-user test (spec §9.5). Another user's id is "not found", never "forbidden" (EC-8).
- No node, lot or transaction ids in URLs (spec §9.5): screens select by control, not by path.
- A price is never silently stale and a missing price is never zero or cost: "not valued", net worth partial (EC-23, EC-24).
- Reuse the shared UI (`SpotlightCard`, `Collapse`, `ChoiceGroup`, `NoticeToast`, `buttonClass`, `inputClass`, `Amount`); the palette has no purple or yellow; keep roles/labels accessible and animations reduced-motion aware.
- Every task ends with `bunx tsc --noEmit`, `bun run lint` (read the output), and its tests green; commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Calls made in this plan (not in the spec — review these)

1. **Remaining quantity is derived, not a column.** The spec lists `quantityRemaining` on the lot, but §9.4 forbids cached figures for the reason that one missed path corrupts them invisibly. Remaining = `quantity − Σ live consumptions`; a lot is live while its buying transaction is not deleted, a consumption while its disposal transaction is not deleted. Delete/restore then unwind for free. Task 4 amends spec §7.2.
2. **The spec's partial-consumption example is internally inconsistent** ("selling 8g" but the arithmetic consumes 13g: 10 + 3). The plan tests 13g → ₹70,000 + ₹22,200 = ₹92,200.
3. **Selling uses its own "Sell / redeem" form** on the investment, not the generic transaction form. A transaction *out of* a QUANTITY/LUMP investment through the generic form is refused with a pointer to Sell, so lots can never drift from the ledger. Fund switches (`INVESTMENT → INVESTMENT` with a lot-mode end) and fees out of a lot-mode investment are refused in M2 ("sell, then buy"); CONTRIBUTION_ONLY investments keep every existing flow (EC-28).
4. **A disposal posts as spec §7.5** (gain: cost-basis leg + Realised Gain leg; loss: proceeds leg + Realised Loss leg). Break-even posts one plain leg. A disposal is deleted/restored as a unit and **cannot be edited** in M2 ("delete and enter it again").
5. **Cost basis of a partial lot** = `round_half_up(costBasisRemaining × take ÷ remaining)`; taking the whole remainder takes `costBasisRemaining` exactly, so lots always sum to the true cost. **Current value** is `round_half_up(Σ open quantity × price)`, rounded once per node.
6. **Valuation is "as of a day"**: open quantity at day *D* counts lots acquired ≤ D and consumptions disposed ≤ D. A disposal may only consume lots acquired on or before its date. Net worth values at today; the "projected" figure reuses today's valuation.
7. **Existing investment data.** A lot-mode node whose live inflows lack a lot, or that has an outflow with no consumption, is **not valued** (reason "needs quantity") until the user edits those entries to add a quantity. Nothing is guessed or backfilled. Expect your own "Nifty Index Fund" to read "not valued" until you add its quantity and a price.
8. **A price cannot be dated after today** (a forecast is not a price); any earlier date is accepted (EC-25). Re-entering a date overwrites (EC-26).
9. **Staleness**: `LedgerNode.stalePriceDays ?? User.stalePriceDays` (30); stale when `today − price.asOf > window`.

## Review Focus

- Selling more than held, or on a date before the lots were bought → refused, stating the quantity available (EC-21). *Task 6.*
- Quantity text like `0`, `-1`, `1e3`, `1,5`, `1.1234567`, ` 5 `, `0.000000` → a field error, never silently rounded or parsed. *Task 1.*
- A node that was fully sold, with and without a price → value ₹0 (nothing held), not "not valued". *Task 3.*
- Restoring a deleted sale after its lots were consumed by another sale, or after the buy was deleted → refused, nothing restored. *Task 6.*
- Legacy investment entries without a lot → "not valued", never zero or cost. *Task 7.*
- Deleting or shrinking a purchase that has been partly sold (EC-13, EC-15); moving its date after a sale. *Task 5.*
- Two requests with one idempotency key for a sale → one disposal. *Task 6.*

---

### Task 1: Quantity arithmetic

**Files:**
- Create: `src/domain/quantity.ts`, `src/domain/quantity.test.ts`

**Interfaces:**
- Produces: `type Quantity = bigint` (micro-units); `QUANTITY_SCALE = 1_000_000n`; `class QuantityParseError extends Error`; `parseQuantity(text: string): Quantity`; `formatQuantity(q: Quantity): string`; `valueOf(q: Quantity, pricePerUnit: Paise): Paise`; `unitPriceOf(amount: Paise, q: Quantity): Paise`; `quantityFor(amount: Paise, pricePerUnit: Paise): Quantity`.

- [ ] **Step 1: Write the failing tests** in `quantity.test.ts`:
  `parseQuantity("10") === 10_000_000n`; `"142.3871" === 142_387_100n`; `"0.000001" === 1n`; leading/trailing spaces trimmed; **throws `QuantityParseError`** for `""`, `"0"`, `"0.000000"`, `"-1"`, `"+1"`, `"1e3"`, `"1,5"`, `"1.1234567"`, `".5"`, `"5."`, `"abc"`, and for more than 12 integer digits (`Decimal(18,6)`). `formatQuantity(10_000_000n) === "10"`, `142_387_100n → "142.3871"`, `1n → "0.000001"`. `valueOf(15_000_000n, 780_000n) === 11_700_000n` (15 g × ₹7,800); `valueOf(1n, 1n) === 0n` and `valueOf(500_000n, 1n) === 1n` (half rounds up). `unitPriceOf(7_000_000n, 10_000_000n) === 700_000n`. `quantityFor(7_000_000n, 700_000n) === 10_000_000n`. Round-trip property over 200 random pairs: `formatQuantity` then `parseQuantity` is the identity.
- [ ] **Step 2:** `bunx vitest run src/domain/quantity.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the functions above in `src/domain/quantity.ts`. `parseQuantity` uses one anchored regex `^\d{1,12}(\.\d{1,6})?$` after trimming; rounding in `valueOf`/`unitPriceOf`/`quantityFor` is half-up on non-negative bigints via `(n * 2n + d) / (2n * d)`.
- [ ] **Step 4:** run the tests → PASS; `bunx vitest run tests/lint` still passes (the file imports only `./money`).
- [ ] **Step 5: Commit** `feat(domain): quantity arithmetic in scaled integers`.

---

### Task 2: Lot allocation

**Files:**
- Create: `src/domain/lots.ts`, `src/domain/lots.test.ts`

**Interfaces:**
- Consumes: `Quantity`, `Paise`, `CalendarDate`, `LotMethod` (from `src/lib/schemas/node.ts` `LOT_METHODS`; import the union type via `typeof LOT_METHODS[number]` re-exported from `ledger-kind.ts` — add `export type LotMethod` there with the same three members and a parity test case).
- Produces: `interface OpenLot { id: string; acquiredAt: CalendarDate; seq: number; quantityRemaining: Quantity; costBasisRemainingPaise: Paise }`; `interface LotAllocation { lotId: string; quantity: Quantity; costBasisPaise: Paise }`; `class InsufficientQuantityError extends Error { available: Quantity; requested: Quantity }`; `allocateLots(lots: readonly OpenLot[], method: LotMethod, quantity: Quantity): LotAllocation[]`.

- [ ] **Step 1: Write the failing tests:**
  Spec example, lots `A: 10 @ ₹70,000` and `B: 5 @ ₹37,000` (acquired in that order): FIFO selling 13 → `[{A,10,7_000_000n},{B,3,2_220_000n}]`, total ₹92,200. LIFO selling 6 → B 5 then A 1 (`700_000n`). HIGHEST_COST_FIRST picks B (₹7,400/unit) before A. Partial then remainder: a lot with remaining basis 7,000,000n and remaining 10 sold 3 then 7 → bases sum to exactly 7,000,000n (no paisa lost). Tie (same acquiredAt) broken by `seq`. Selling exactly everything allocates every lot. Quantity `0n` or negative throws. Selling more than held throws `InsufficientQuantityError` with `available` = total remaining (EC-21). Lots with `quantityRemaining === 0n` are skipped. Property: for random lots and a random feasible quantity, `Σ allocation.quantity === quantity` and `Σ costBasisPaise ≤ Σ lot basis`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** `allocateLots`. Order by method (FIFO: `acquiredAt` asc then `seq`; LIFO: reverse; HIGHEST_COST_FIRST: remaining unit cost desc by cross-multiplication `a.basis * b.qty` vs `b.basis * a.qty`, ties by FIFO). Per lot: `take = min(remaining, needed)`; basis = `costBasisRemainingPaise` if `take === quantityRemaining` else half-up `basisRemaining * take / quantityRemaining`.
- [ ] **Step 4:** run → PASS. **Step 5: Commit** `feat(domain): FIFO, LIFO and highest-cost lot allocation`.

---

### Task 3: Valuation

**Files:**
- Modify: `src/domain/calendar-date.ts` (add `daysBetween(from: CalendarDate, to: CalendarDate): number`, whole days, negative if `to` is earlier) and `calendar-date.test.ts`
- Create: `src/domain/valuation.ts`, `src/domain/valuation.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  `interface HoldingLot { id: string; acquiredAt: CalendarDate; seq: number; quantity: Quantity; costBasisPaise: Paise; consumptions: { quantity: Quantity; costBasisPaise: Paise; disposedAt: CalendarDate }[] }`
  `openLots(lots: readonly HoldingLot[], asOf?: CalendarDate): OpenLot[]` — with `asOf`, only lots acquired ≤ asOf and consumptions disposed ≤ asOf count; without it every consumption counts (what a new disposal allocates from, call 6).
  `interface PricePoint { asOf: CalendarDate; pricePerUnitPaise: Paise }`; `latestPrice(points: readonly PricePoint[], asOf: CalendarDate): PricePoint | null`
  `interface Holding { quantityHeld: Quantity; costBasisPaise: Paise; price: (PricePoint & { stale: boolean }) | null; valuePaise: Paise | null; unrealisedGainPaise: Paise | null; gainBasisPoints: bigint | null }`
  `valueHolding(input: { lots: readonly HoldingLot[]; points: readonly PricePoint[]; asOf: CalendarDate; stalePriceDays: number }): Holding`

- [ ] **Step 1: Write the failing tests** (`daysBetween("2026-03-01","2026-03-31") === 30`, across a leap day and a month end; then valuation): no points and quantity held → `valuePaise === null`, `price === null`; points entered out of order resolve by `asOf` not insertion (EC-25); a point dated after `asOf` is ignored; `quantityHeld === 0n` → `valuePaise === 0n` with and without points (call in Review Focus); gold example: lots 10 @ 70,000 and 5 @ 37,000, price ₹7,800 → value 11_700_000n, cost 10_700_000n, gain 1_000_000n, `gainBasisPoints === 935n` (9.346% rounds half-up to 9.35%); loss gives a negative gain and negative basis points; stale is `false` at exactly `stalePriceDays` days old and `true` at one day more; consumption disposed after `asOf` still counts as held at `asOf`; a lot acquired after `asOf` is excluded; `costBasisPaise` is the **remaining** basis of open lots; `gainBasisPoints` is `null` when cost is 0.
- [ ] **Step 2:** run → FAIL. **Step 3: Implement** per the interfaces; `valueHolding` calls `openLots(lots, asOf)`, sums quantity and remaining basis, then `valueOf(totalQuantity, price)` once (call 5).
- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(domain): holding valuation with staleness`.

---

### Task 4: Schema, migration and spec amendments

**Files:**
- Modify: `prisma/schema.prisma`, `src/domain/ledger-kind.ts` (add `PRICE_SOURCES = ["MANUAL","FEED"] as const`), `tests/db/enum-parity.test.ts`, `tests/db/schema.test.ts`, `docs/superpowers/specs/2026-09-11-accufi-design.md`
- Create: `prisma/migrations/<timestamp>_investments/migration.sql` (via `bunx prisma migrate dev --name investments`)

**Interfaces:**
- Produces Prisma models:
  `InvestmentLot { id, userId, nodeId, transactionId @unique, quantity Decimal(18,6), costBasisPaise BigInt, acquiredAt Date, createdAt }` — index `(userId, nodeId, acquiredAt)`.
  `LotConsumption { id, userId, lotId, transactionId, quantity Decimal(18,6), costBasisPaise BigInt, createdAt }` — `@@unique([lotId, transactionId])`, index `(userId, transactionId)`. `transactionId` is the disposal's **cost-basis leg**.
  `PriceSnapshot { id, userId, nodeId, asOf Date, pricePerUnitPaise BigInt, source PriceSource @default(MANUAL), createdAt, updatedAt }` — `@@unique([nodeId, asOf])`, index `(userId, nodeId, asOf)`.
  enum `PriceSource { MANUAL FEED }`. Relations from `User`, `LedgerNode`, `Transaction`.

- [ ] **Step 1: Write failing DB tests** in `tests/db/schema.test.ts`: inserting a lot with `quantity = 0` or `costBasisPaise = 0` fails; a second lot for the same `transactionId` fails; two snapshots for the same `(nodeId, asOf)` fail; a snapshot with `pricePerUnitPaise = 0` fails; a consumption pair `(lotId, transactionId)` twice fails; `PriceSource` members equal `PRICE_SOURCES` (enum-parity).
- [ ] **Step 2:** run `bunx vitest run tests/db` → FAIL.
- [ ] **Step 3:** add the models and enum; run `bunx prisma migrate dev --name investments`; hand-add `CHECK ("quantity" > 0)`, `CHECK ("costBasisPaise" > 0)`, `CHECK ("pricePerUnitPaise" > 0)` to the generated SQL (and `quantity > 0` on consumptions).
- [ ] **Step 4:** run `bunx vitest run tests/db` → PASS.
- [ ] **Step 5: Amend the spec**: §7.2 — remove `quantityRemaining` from the lot and state that remaining is derived (call 1); §7.5 — the example sells 13g, not 8g (call 2); add the M2 calls 3, 4, 6, 7, 8 as a short "M2 rulings" list. **Commit** `feat(db): lots, lot consumptions and price snapshots`.

---

### Task 5: Repositories and lot rules on the write path

**Files:**
- Create: `src/server/repositories/lot-repository.ts`, `src/server/repositories/price-repository.ts`, `tests/server/repositories/lots.test.ts`, `tests/server/repositories/prices.test.ts`
- Modify: `src/server/repositories/user-repository.ts` (add `findStalePriceDays(userId): Promise<number>`), `tests/server/repositories/isolation.test.ts`, `src/server/services/transaction-service.ts`, `src/lib/schemas/transaction.ts`, `src/server/repositories/transaction-repository.ts` (only if a lookup is missing)
- Test: `tests/server/transaction-service.test.ts` (extend), `src/lib/schemas/transaction.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 `Quantity`, Task 3 `HoldingLot`.
- Produces (all `userId` first; `uow?: UnitOfWork` last):
  `insertLot(userId, data: { nodeId; transactionId; quantity: Quantity; costBasisPaise: Paise; acquiredAt: CalendarDate }, uow): Promise<void>`
  `updateLot(userId, transactionId, data: Partial<{ nodeId; quantity; costBasisPaise; acquiredAt }>, uow): Promise<void>`
  `deleteLotOf(userId, transactionId, uow): Promise<void>`
  `findLiveLots(userId, nodeId, uow?): Promise<HoldingLot[]>` — lots whose buying transaction is not deleted, each with its live consumptions (disposal transaction not deleted, carrying the disposal's `occurredAt`), `seq` = creation order.
  `findLotByTransaction(userId, transactionId, uow?): Promise<(HoldingLot & { live: boolean }) | null>`
  `insertConsumptions(userId, rows: { lotId; transactionId; quantity; costBasisPaise }[], uow): Promise<void>`
  `findConsumptionsByTransaction(userId, transactionId, uow?): Promise<{ lotId; quantity; costBasisPaise }[]>` (live or not)
  `findLotGaps(userId, nodeId, uow?): Promise<{ inflowsWithoutLot: number; outflowsWithoutConsumption: number }>` — counts live transactions into the node with no lot and live transactions out of it with no consumption.
  `upsertPrice(userId, data: { nodeId; asOf; pricePerUnitPaise }): Promise<void>`; `listPrices(userId, nodeId): Promise<PricePoint[]>` (ascending `asOf`); `deletePrice(userId, nodeId, asOf): Promise<void>`.
  Transaction service/schema additions: `RecordTransactionInput.quantity?: Quantity`, `EditTransactionInput.quantity?: Quantity`; schema field `quantity: z.string()` parsed by `parseQuantity` as a validation issue (same style as `occurredAt`), optional; `class LotInUseError extends InvalidTransactionError`.

- [ ] **Step 1: Write failing repository tests** (`lots.test.ts`, `prices.test.ts`, both with a second user's ids returning nothing / not-found — add each function to `isolation.test.ts`): inserting a lot then `findLiveLots` returns it with `quantity` as the same bigint micro-units written (round trip through `Decimal`); soft-deleting the buying transaction removes the lot from `findLiveLots`, restoring it brings it back; a consumption whose disposal transaction is soft-deleted is absent from the lot's `consumptions`; `findLotGaps` counts a legacy inflow with no lot; `upsertPrice` twice for one date leaves one row holding the second price (EC-26); `listPrices` returns ascending by date regardless of insertion order.
- [ ] **Step 2:** run `bunx vitest run tests/server/repositories` → FAIL.
- [ ] **Step 3: Implement** the repository functions. Convert `Prisma.Decimal` ↔ `Quantity` only inside the repository (`BigInt(decimal.mul(1_000_000).toFixed(0))` / `new Prisma.Decimal(q.toString()).div(1_000_000)`), never through `Number`.
- [ ] **Step 4:** run → PASS. **Commit** `feat(server): lot and price repositories`.
- [ ] **Step 5: Write failing service tests** in `tests/server/transaction-service.test.ts` (investment nodes created with each `valuationMode`):
  - `recordTransaction` into a QUANTITY node **without** `quantity` → `InvalidTransactionError` "Enter the quantity bought" (field `quantity`); with it → one lot whose `costBasisPaise` equals the amount and `acquiredAt` the transaction date.
  - Into a LUMP node: lot of quantity exactly `1_000_000n`; `quantity: 2_000_000n` → error.
  - `quantity` on a CONTRIBUTION_ONLY node or any non-investment destination → error "Quantity applies only to investments valued by quantity"; no lot, no row.
  - A split leg whose destination is a QUANTITY/LUMP node → error naming the leg ("record an investment purchase on its own").
  - Generic `recordTransaction` **from** a QUANTITY/LUMP node → error "Use Sell on the Investments screen" (Review call 3), also `INVESTMENT → INVESTMENT` with a lot-mode end; CONTRIBUTION_ONLY → ASSET still records (EC-28).
  - `editTransaction` changing amount/quantity/date updates the lot in lockstep (EC-15); rejected when the new quantity is below the consumed quantity ("Already sold: 3 of the 5") or the new date is after a consuming disposal's date; changing the target away from a lot-mode investment deletes the lot unless consumed (EC-16); editing a transaction in a DISPOSAL group or with consumptions → error "A sale is deleted and entered again, not edited"; editing a legacy inflow to supply `quantity` creates its lot.
  - `removeTransaction` of a lot-creating transaction with live consumptions → `LotInUseError` ("Delete the sale first"), nothing changes; after the sale is deleted it succeeds.
- [ ] **Step 6:** run → FAIL.
- [ ] **Step 7: Implement** in `transaction-service.ts`: a helper `lotModeOf(node): "QUANTITY" | "LUMP" | null`; the lot write goes in the same `uow` as the insert/update inside `writeUnlessOverdrawn`; `assertNoLotFlow(from, to)` for the generic path; the DISPOSAL/consumption edit guard beside the existing `ungroupTransaction` DISPOSAL check. Schema: add optional `quantity` to `recordTransactionSchema` and `changes`.
- [ ] **Step 8:** run `bun run test` fully → PASS. **Commit** `feat(server): purchases create lots; lot rules on edit and delete`.

---

### Task 6: Disposals

**Files:**
- Create: `src/server/services/investment-service.ts` (disposal half), `src/lib/schemas/investment.ts`, `tests/server/disposal.test.ts`
- Modify: `src/server/services/transaction-service.ts` (`restoreTransaction` re-validation), `src/server/services/transaction-service.ts` exports `requireNode`/`cleanNote` if the new service needs them (export, do not duplicate)

**Interfaces:**
- Consumes: Tasks 2, 3, 5; `createTransactionGroup(userId, "DISPOSAL", uow)`, `insertTransactions`, system nodes via `findNodes`/`systemRole`.
- Produces: `interface SellInput { nodeId: string; toNodeId: string; quantity: Quantity; proceeds: Paise; occurredAt: CalendarDate; note?: string; idempotencyKey: string }`; `interface SalePreview { costBasisPaise: Paise; proceedsPaise: Paise; gainPaise: Paise /* signed */; allocations: { acquiredAt: CalendarDate; quantity: Quantity; costBasisPaise: Paise }[] }`; `previewSale(userId, input: Omit<SellInput, "idempotencyKey" | "note">): Promise<SalePreview>`; `sellInvestment(userId, input: SellInput): Promise<{ legs: TransactionView[]; preview: SalePreview }>`; Zod `sellSchema`, `previewSaleSchema` (rupees → paise, quantity text → `Quantity`, same key rules) in `investment.ts`.

- [ ] **Step 1: Write failing tests** (`disposal.test.ts`; account A with a bank asset, a QUANTITY gold node FIFO; buy 10g for ₹70,000 on 1 Jan and 5g for ₹37,000 on 1 Feb via `recordTransaction`):
  - **Gain** — sell 8g for ₹68,000 on 1 Mar: group kind `DISPOSAL` with legs `gold → bank ₹56,000` and `Realised Gain → bank ₹12,000`; lot A has 2g left (basis ₹14,000), lot B untouched; bank balance +₹68,000; gold contribution balance −₹56,000 (₹51,000 left of ₹1,07,000); one consumption row pointing at the cost-basis leg.
  - **Loss** — sell 8g for ₹50,000: legs `gold → bank ₹50,000` and `gold → Realised Loss ₹6,000`.
  - **Break-even** — sell 8g for ₹56,000: one transaction, no group, consumption attached.
  - Spans lots: sell 13g → cost basis ₹92,200 (Task 2 example), lots A empty and B 2g left.
  - LIFO node consumes B first.
  - **Refused, nothing written:** selling 16g (available 15) → `InsufficientQuantityError` message states 15 available (EC-21); selling 12g **dated 15 Jan** (only lot A, 10g, exists then) → available 10; quantity/proceeds ≤ 0; destination an `EXPENSE`/`INVESTMENT`; archived destination; CONTRIBUTION_ONLY node ("Record this as an ordinary transaction", EC-28); another user's node → `NotFoundError`.
  - LUMP node: selling quantity ≠ 1 refused; selling 1 posts correctly.
  - **Idempotency:** the same key twice → one group (same legs returned); a different shape on the same key → `RequestKeyConflictError`.
  - **Delete/restore:** `removeTransaction(costBasisLeg)` deletes the whole group, puts lot A back to 10g (derived remaining) and the gold balance back to ₹1,07,000; `restoreTransaction` brings it back and re-allocates nothing (consumption rows are kept). **Restore refused** (`InsufficientQuantityError`, nothing restored) when another sale has since consumed the lots, and when the lot's buying transaction is deleted.
  - `previewSale` returns the same numbers `sellInvestment` writes and writes nothing.
- [ ] **Step 2:** run `bunx vitest run tests/server/disposal.test.ts` → FAIL.
- [ ] **Step 3: Implement** `previewSale` (load live lots → `openLots(lots)` with **no** `asOf` filter except `acquiredAt ≤ occurredAt` → `allocateLots` using the node's `lotMethod ?? "FIFO"`) and `sellInvestment` (one `inTransaction`: group, legs per spec §7.5, `insertConsumptions` against the cost-basis leg; leg keys `<key>:0`, `<key>:1` with the same replay lookup shape as `storedSplit`). Extend `restoreTransaction`: after restoring, for every restored row that has consumptions, re-check each lot is live and `remaining ≥ consumption.quantity` counting only the other live consumptions; throw `InsufficientQuantityError`/`LotInUseError` and roll back otherwise.
- [ ] **Step 4:** `bun run test` → PASS. **Commit** `feat(server): sell an investment as a FIFO disposal`.

---

### Task 7: Prices and valuation services, wired into net worth

**Files:**
- Create: `src/lib/investment-view.ts`, `src/server/services/price-service.ts`, `src/server/services/price-resolver.ts`, `tests/server/valuation-service.test.ts`
- Modify: `src/server/services/investment-service.ts` (read half), `src/server/services/balance-service.ts`, `src/server/services/node-overview.ts`, `src/lib/node-overview.ts`, `src/lib/dashboard-view.ts`, `src/lib/node-view.ts` (only if the ledger row needs the valuation state), `tests/server/{dashboard-render,node-overview,net-worth}.test.ts`, `tests/e2e/seed.ts` (investment seed helpers), existing e2e dashboard/ledger specs whose seeds use QUANTITY/LUMP nodes

**Interfaces:**
- Consumes: Tasks 3, 5.
- Produces:
  `interface PriceResolver { pricesFor(userId: string, nodeId: string): Promise<PricePoint[]> }`; `snapshotPriceResolver: PriceResolver` (reads `listPrices`) — the §7.4 seam, so a feed implements the same interface.
  `src/lib/investment-view.ts`: `HoldingView { nodeId; name; unitLabel; valuationMode; archived; quantityHeld: string; costBasisPaise: string; valuePaise: string | null; unrealisedGainPaise: string | null; gainBasisPoints: number | null; price: { asOf: CalendarDate; pricePerUnitPaise: string; stale: boolean } | null; notValued: "NO_PRICE" | "NEEDS_QUANTITY" | null; lotCount: number }`, `LotView { id; acquiredAt; quantity: string; quantityRemaining: string; costBasisPaise: string; costBasisRemainingPaise: string }`, `HoldingDetail extends HoldingView { lots: LotView[]; prices: { asOf; pricePerUnitPaise: string }[] }`, `Portfolio { holdings: HoldingView[]; totals: { contributedPaise: string; valuePaise: string; unrealisedGainPaise: string; notValuedCount: number } }` (all strings/numbers, no bigint or Date).
  `loadHolding(userId, nodeId, asOf?): Promise<HoldingDetail>`; `loadPortfolio(userId, asOf?): Promise<Portfolio>`; `loadValuations(userId, asOf: CalendarDate): Promise<Map<string, Paise | null>>` — only lot-mode nodes appear in the map; a node with gaps (`findLotGaps` > 0) or a held quantity with no price maps to `null`.
  `recordPrice(userId, { nodeId, asOf, pricePerUnit: Paise }): Promise<void>`, `deletePrice(userId, nodeId, asOf)`, `previewRevaluation(userId, { nodeId, asOf, pricePerUnit }): Promise<{ beforePaise: Paise | null; afterPaise: Paise; changePaise: Paise | null }>` (before = value at today with the existing price; after = with the proposed one).
  `NodeOverview.unvalued: Record<string, "NO_PRICE" | "NEEDS_QUANTITY">` and the INVESTMENT kind total/`balances[id]` for a lot-mode node = its value when valued, `"0"` when not.

- [ ] **Step 1: Write failing tests** (`valuation-service.test.ts`): after the Task 6 purchases and a ₹7,800 price on 1 Mar, `loadValuations(today)` maps the gold node to `11_700_000n`; with no price → `null`; a price dated 31 days ago with node `stalePriceDays` 30 → `HoldingView.price.stale === true`, with a node override of 400 → `false`; a fully sold node → `0n`; a legacy inflow with no lot (insert via the repository directly) → `null` with `notValued: "NEEDS_QUANTITY"`; CONTRIBUTION_ONLY node is **absent** from the map and its balance still counts in net worth; `loadPortfolio` totals equal the sum of its rows; `recordPrice` twice for a date overwrites (EC-26); a price dated tomorrow → `InvalidPriceError` (call 8); another user's node → `NotFoundError`; a CONTRIBUTION_ONLY node → refused ("This investment is not revalued"); `previewRevaluation` writes nothing. Dashboard test: with one unvalued lot-mode node, `netWorth.isPartial === true`, `unvaluedNames` lists it and `total` excludes it.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** the services, then pass `await loadValuations(userId, today)` into `buildDashboard({ ..., valuations })` (`balance-service.ts`) and `buildNodeOverview(nodes, balances, valuations)` (`node-overview.ts`); in `buildNodeOverview` make INVESTMENT totals/balances use the valuation as described above and fill `unvalued`.
- [ ] **Step 4:** run `bun run test`; update the seeds/assertions of existing tests that put money into QUANTITY/LUMP nodes (they are now partial by design) — change the *seed* (give them quantity and a price, or use CONTRIBUTION_ONLY) rather than weakening an assertion. → PASS.
- [ ] **Step 5: Commit** `feat(server): price history, holdings and valuation feed net worth`.

---

### Task 8: Server Actions

**Files:**
- Create: `src/app/investments/actions.ts`, `tests/server/investment-actions.test.ts`
- Modify: `src/server/action-support.ts` (only if a new error code is needed), `src/lib/schemas/investment.ts`

**Interfaces:**
- Consumes: Tasks 6–7.
- Produces (each calls `requireUserId()` first, parses `unknown` with Zod, returns `ActionResult<T>`, writes call `wrote(...)` like the node actions; `/investments` is added to the paths `wrote` revalidates): `getHoldingAction(input: unknown)`, `previewSaleAction`, `sellAction`, `previewPriceAction`, `recordPriceAction`, `deletePriceAction`. Field errors use the form field names: `quantity`, `proceeds`, `toNodeId`, `occurredAt`, `price`, `asOf`.

- [ ] **Step 1: Write failing tests** in the style of `tests/server/transaction-actions.test.ts`: no session → redirect; unknown keys rejected by `strictObject`; `InsufficientQuantityError` → `{ ok:false, error:{ code:"insufficient_quantity", fieldErrors:{ quantity:[message] } } }`; `InvalidPriceError` → `fieldErrors.asOf`; success results contain no bigint/Date (`JSON.stringify` does not throw); another user's `nodeId` → `not_found`.
- [ ] **Step 2:** FAIL. **Step 3: Implement** the actions and the error→field mapping (own small table like `FIELD_OF_VIOLATION`). **Step 4:** PASS. **Commit** `feat(app): investment server actions`.

---

### Task 9: Investments screen

**Files:**
- Create: `src/app/investments/{page.tsx,loading.tsx,investments-workspace.tsx,holding-card.tsx,lot-table.tsx,sell-form.tsx}`
- Modify: `src/app/app-nav.tsx` (new item "Investments"), `src/app/nodes/kind-icons.ts` if reused, `src/components/ui/loading-screen.tsx` (`InvestmentsSkeleton`), `src/app/transactions/pickers.ts` and `src/lib/transaction-list-view.ts` (`PickerNode` gains `valuationMode` and `unitLabel`)
- Test: `tests/e2e/investments.spec.ts`

**Interfaces:**
- Consumes: Task 7 views, Task 8 actions. `Portfolio` is loaded in `page.tsx`; a holding's detail loads on open via `getHoldingAction` (no ids in the URL).
- Produces: `/investments` with: a hero `SpotlightCard` (contributed, current value, unrealised gain with sign and %, "N not valued" note naming them); one `HoldingCard` per investment (`h2` name, value or **"Not valued"** with its reason and a link to `/investments/prices`, price line "₹7,800 per gram as of 1 Mar 2026" with a **"Stale"** pill when stale, gain in `text-negative` when negative); expanding a card shows the aggregated holding (quantity, cost basis, value) and a **"Show lots"** `Switch` revealing `LotTable` (one row per lot: date, quantity, remaining, cost); a **Sell / redeem** button opening `SellForm` (a form named "Sell {name}": quantity, "Proceeds (₹)", destination `select` of the user's assets and liabilities, date, note; as the fields change it asks `previewSaleAction` and shows "Cost basis ₹X · gain ₹Y" in a polite live region; submit calls `sellAction`, then a toast with the gain/loss and the cost basis).

- [ ] **Step 1: Write the failing e2e** `investments.spec.ts` (the spec's M2 acceptance row, with the shared fixtures in `tests/e2e/fixtures.ts`): create a bank account with ₹2,00,000 opening, a gold investment (QUANTITY, gram, FIFO); on Transactions buy **10 g for ₹70,000** and **5 g for ₹37,000** (the form shows the Quantity field; amount ÷ quantity shows the unit price); `/investments` shows gold "Not valued"; on `/investments/prices` (Task 10) set ₹7,800 → card shows value **₹1,17,000.00**, cost ₹1,07,000.00, gain **₹10,000.00 (9.35%)**; **Sell 8 g for ₹68,000** → toast states cost basis ₹56,000.00 and gain ₹12,000.00; card now shows 7 g, cost ₹51,000.00; Transactions lists the split "Split from Gold" with the Realised Gain leg; the bank balance rose by ₹68,000.00; selling 8 g more is refused with "Only 7 available"; deleting the first purchase is refused ("Delete the sale first"); deleting the sale then restores 15 g. Role/label contracts: heading levels, `button` names "Sell / redeem", "Show lots" switch, form "Sell Gold".
- [ ] **Step 2:** `bunx playwright test tests/e2e/investments.spec.ts` → FAIL.
- [ ] **Step 3: Implement** the screen with the existing primitives; amounts render through `Amount`; the unvalued state never renders a figure. Add `InvestmentsSkeleton` and `loading.tsx` (a `loading.tsx` makes `goto` resolve at the skeleton: the spec waits for real headings).
- [ ] **Step 4:** run the spec (Task 10 steps unblock its prices part; run the sections that exist, finish both then re-run whole) → PASS. **Commit** `feat(ui): investments screen with holdings, lots and sell form`.

---

### Task 10: Price entry screen

**Files:**
- Create: `src/app/investments/prices/{page.tsx,loading.tsx,price-form.tsx,price-history.tsx}`
- Test: extend `tests/e2e/investments.spec.ts`

**Interfaces:**
- Consumes: `previewPriceAction`, `recordPriceAction`, `deletePriceAction`, `Portfolio` (to list the revaluable nodes: QUANTITY and LUMP only).
- Produces: `/investments/prices`: a form named "Record a price": "Investment" `select`, "Date" (default today, not after today), "Price per {unit} (₹)"; with all three present it shows **"Value now ₹A → ₹B (+₹C)"** from `previewPriceAction` (or "Not valued yet → ₹B" for a node that had no price) before saving; "Save price" records and toasts; below it the selected investment's price history (newest first, each with its date, price, a **Delete** button) — re-saving a date shows it replaced.

- [ ] **Step 1: Extend the e2e:** the preview text appears before saving and a refused future date shows its error beside the Date field; saving the same date twice leaves one history row with the second price; deleting the only price makes the card "Not valued" again; a CONTRIBUTION_ONLY investment is not offered in the select.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** Preview requests are debounced and ignore out-of-order responses (a stale preview must never overwrite a newer one). **Step 4:** PASS. **Commit** `feat(ui): price entry with a revaluation preview`.

---

### Task 11: Purchase and node forms

**Files:**
- Modify: `src/app/transactions/transaction-form.tsx`, `src/app/transactions/transaction-failure.ts`, `src/app/nodes/node-fields.ts`, `src/lib/schemas/node.ts`, `src/server/services/node-service.ts`, `src/app/nodes/node-list.tsx` (details list shows the stale window)
- Create: `src/lib/quantity-fields.ts`, `src/lib/quantity-fields.test.ts`
- Test: `tests/e2e/transactions.spec.ts` (extend), `src/lib/schemas/node.test.ts`, `src/app/nodes/node-fields.test.ts`

**Interfaces:**
- Consumes: Task 1 functions, Task 5 service behaviour, `PickerNode.valuationMode/unitLabel` (Task 9).
- Produces: `completeTriple(edited: "amount" | "quantity" | "unitPrice", values: { amount: string; quantity: string; unitPrice: string }): { amount: string; quantity: string; unitPrice: string }` — given the two most recently edited fields, fills the third in text (rupees to 2 dp, quantity to 6 dp trimmed), leaving all three untouched if either input does not parse. Node schema field `stalePriceDays: z.number().int().min(1).max(3650).optional()` on `investment`, passed to the node row.

- [ ] **Step 1: Write failing tests:** `completeTriple("amount", { amount: "70000", quantity: "10", unitPrice: "" })` → unit price `"7000.00"`; editing quantity with amount and price present recomputes the amount; unparsable input returns the values unchanged; node schema accepts `stalePriceDays: 365` and rejects `0`, `3651`, `1.5`; e2e: choosing a gold destination reveals "Quantity (gram)" and "Price per gram (₹)", choosing a LUMP investment reveals neither and shows "A single holding"; submitting with the quantity missing shows the error beside Quantity and keeps what was typed; the ledger create form for an investment offers "Price goes stale after (days)" (optional) and the row's details show it when set.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** The form sends `quantity` only for QUANTITY destinations; the failure mapper files a `quantity` message under that field. **Step 4:** run `bun run test` and `bunx playwright test` (whole suite) → PASS. **Commit** `feat(ui): quantity on purchases, stale window on investments`.

---

### Task 12: Verification, rulings and release

**Files:**
- Create: `docs/superpowers/decisions/2026-10-20-m2-rulings.md` (the nine calls, each with the cost if wrong, as in the M1 rulings file)
- Modify: `tests/e2e/isolation.spec.ts` (a second user cannot see or sell the first user's investment, nor read its prices), `README`/docs if they list screens

- [ ] **Step 1:** add the isolation e2e (user B signs in: `/investments` lists none of A's holdings; B's `getHoldingAction` with A's node id returns `not_found`).
- [ ] **Step 2: Full gates**, each read, not assumed: `bunx tsc --noEmit` (exit 0), `bun run lint` (no warnings), `bun run build` (exit 0), `bun run test` (both timezone passes), `bunx playwright test` (no dev server running).
- [ ] **Step 3:** `docker compose up --build -d`; sign in as the local account and walk `/investments`, `/investments/prices` and the dashboard in dark and light; confirm the dashboard names the not-valued investment and states the figure is partial; screenshots to the user.
- [ ] **Step 4:** write the rulings file; **Commit** `docs: M2 rulings` and `test: investment isolation`. Merging and pushing remain the user's decision.

---

## Self-review

- **Spec coverage:** §7.1 modes → Tasks 5, 6, 7 (QUANTITY/LUMP lots, CONTRIBUTION_ONLY untouched); §7.2 lots → 4, 5; §7.3 prices/value/stale/unique/out-of-order → 3, 7, 10; §7.4 `PriceResolver` → 7; §7.5 disposals, lot methods, consumption → 2, 6; §8.2 holdings view, portfolio, price screen with preview → 9, 10; EC-13 → 5, 6; EC-15/16 → 5; EC-19 (disposal edited as a unit) → 5, 6; EC-21 → 2, 6; EC-22 → 2, 6; EC-23/24/25/26 → 3, 7, 10; EC-27 → 1; EC-28 → 5, 6; EC-29 → existing node rules (archive/delete) unchanged and retested in Task 12 gates; EC-30 → 3 (LUMP = quantity 1); EC-31 → 9 (aggregate by default, lots on demand). Not covered by design: fund switches, fees out of lot-mode investments, editing a disposal (calls 3–4), `source = FEED` (seam only).
- **Type consistency:** `Quantity`, `OpenLot`, `HoldingLot`, `PricePoint`, `Holding`, `SalePreview`, `HoldingView`/`HoldingDetail`/`Portfolio` are defined once (Tasks 1–3, 6, 7) and used by name afterwards; repository names (`findLiveLots`, `insertLot`, `findLotGaps`, `upsertPrice`, `listPrices`) match their callers.
- **Proportion:** the plan states signatures, test names and values and leaves bodies to the implementer; the longest passages are test lists, which carry the spec's exact figures.
