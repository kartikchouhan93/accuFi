# AccuFi M3 — Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six reports (net worth over time, income vs expense, spending by ledger, income by source, account history, investment growth) plus a dashboard strip and trend, where every figure drills through to a transaction list that adds up to it.

**Architecture:** Pure period and aggregation maths in `src/domain`; SQL aggregates in one new repository (`report-repository.ts`); one `report-service.ts` that reuses `netWorth()`, `valueHolding()` and the M2 valuation inputs, so a report cannot disagree with the dashboard; serialisable views in `src/lib`; Server Component pages under `src/app/reports` with hand-written SVG charts. The Transactions screen gains a multi-node filter, a `flow` filter and a SQL filtered total, which is how a drill is proved.

**Tech Stack:** Bun, Next.js 16 (App Router), React 19, Prisma 6 / PostgreSQL, Tailwind 4, Vitest, Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-accufi-m3-reports-design.md` (approved 2026-10-27; amended at planning in §5 and §6.4). Parent spec: `docs/superpowers/specs/2026-09-11-accufi-design.md` §4.2, §6.4, §7.3, §8.3, EC-9/10/20/23–25/32/38/39/62.

## Global Constraints

- Money is integer paise (`bigint`), shown as paise **text** across the server/client boundary (`serialisePaise`), never a `Number`. The one exception is chart geometry: a paise string may be converted with `Number()` to place a mark, and that number is never displayed or summed.
- Classify by node **kind**, never by the sign of an amount. Income = out of an `INCOME_SOURCE`; spending = into an `EXPENSE` minus out of it. The system nodes `OPENING_BALANCE` and `OPENING_BALANCE_CONTRA` are in no income or spending figure; `REALISED_GAIN` and `REALISED_LOSS` are, tagged "from investment sales".
- Layering: `src/domain` imports nothing from Prisma, Next or server (lint-enforced); `src/lib` value imports of domain code are **relative**, not `@/`; repositories are the only code touching tables and take `userId` first, in every `where`.
- Aggregates are SQL (EC-62). Soft-deleted transactions never count. Archived nodes always count (EC-32). Reports exclude the future (EC-10): a range's end is clamped to today in the user's timezone.
- Past months are valued at the prices known for that month: `valueHolding` as of the month-end, price "latest on or before" (EC-25). A held quantity with no price is **not valued**, never ₹0 or cost (EC-23); a price older than the window at that month-end is **stale** (EC-24).
- One arithmetic: reports call `netWorth()`, `valuationStatesFrom()`, `valueHolding()`, `sumBalances()`. No second implementation.
- Periods follow the user's timezone and `financialYearStartMonth` (default 4). Series are monthly; account history is daily for ranges of 93 days or fewer. Custom ranges are capped at 3660 days (`MAX_RANGE_DAYS`).
- Palette: Graphite & Azure tokens only (`accent`, `positive`, `negative`, `fg-soft`, `line-strong`, `notice-*`); no purple, no yellow, no new hue. Effects respect reduced motion. Every chart has a "View as table" with the same numbers.
- Tests: Vitest runs in both timezone passes (`sh scripts/test-tz.sh <file>`); expected figures are hand-worked literals, never computed with the code under test. Full gate before each task's commit: `bunx tsc --noEmit`, `bun run lint`, and the task's tests.
- End every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

Failure modes the spec implies that no feature test would otherwise exercise, most likely first. Each is pinned in the task named.

1. **Hostile or malformed URL parameters** (`range=month-2026-13`, `fy-abc`, `custom` with no `to`, a reversed or 40-year range, a repeated parameter, another user's node id, `flow=bogus`): the page shows an error beside the control and falls back to the default; it never throws or leaks. (Tasks 1, 3, 9)
2. **Degenerate data**: a user with no transactions, one transaction, or a range with no activity: no NaN, no division by zero, an empty state instead of a flat chart of zeros, no share on a ledger with no positive spend. (Tasks 2, 5, 8)
3. **A user whose today differs from the server's** (Pacific/Kiritimati is UTC+14, Pacific/Pago_Pago UTC−11): the last bucket ends on the user's today and a month boundary is the user's. (Task 5)
4. **Parent/child ledgers**: an archived child, a child whose parent is not a reportable node of the same kind, a child that is refund-only inside a positive parent. (Task 2)
5. **Amounts beyond 2^53 paise**: text and shares stay exact, charts still render. (Tasks 2, 7)

## File Structure

| File | Responsibility |
|---|---|
| `src/domain/calendar-date.ts` (modify) | `addDays` |
| `src/domain/periods.ts` (new) | range choice → resolved range; URL grammar; month/day buckets; history clip; picker lists |
| `src/domain/reports.ts` (new) | pure aggregation: reportable nodes, cash flow, ranking and roll-up, shares, running balances, portfolio point |
| `src/lib/schemas/transaction.ts`, `src/lib/transaction-list-view.ts`, `src/server/services/transaction-list.ts`, `src/server/repositories/transaction-repository.ts`, `src/app/transactions/{filters,filtered-total,transaction-workspace}.tsx` (modify/new) | multi-node + `flow` filter, `sumNetIntoNodes`, filtered-total line |
| `src/server/repositories/report-repository.ts` (new), `user-repository.ts` (modify) | SQL aggregates; FY start month |
| `src/lib/report-view.ts`, `src/lib/report-drill.ts`, `src/lib/report-nav.ts` (new) | view types; drill hrefs; report list |
| `src/server/services/report-service.ts` (new) | one loader per report |
| `src/components/charts/*` (new) | `chart-scale.ts`, `chart-frame.tsx`, `line-chart.tsx`, `bar-chart.tsx`, `ranked-bars.tsx`, `sparkline.tsx` |
| `src/app/reports/**` (new) | shell, tabs, range control, dispatcher page, six report components, skeleton |
| `src/app/page.tsx`, `net-worth-card.tsx`, `this-month.tsx`, `balance-service.ts`, `dashboard-view.ts` (modify/new) | dashboard strip, trend, links |
| `tests/server/reports/scenarios.ts` (new) | the two worked ledgers every report test uses |

## Shared scenarios (built once in Task 4, used by Tasks 4–9)

Both are created for a fresh user after `seedAccountNodes` (which gives the four system nodes and the starter ledgers Groceries, Rent, Utilities, Transport, Dining, Health), through `recordTransaction`, so they pass the same legality rules the app does. Amounts are rupees; the assertions below are in paise (×100). Every row is live unless stated. Range under test: custom 2026-01-01 → 2026-03-31.

**Scenario F (flows).** Extra nodes: Salary and Interest (`INCOME_SOURCE`), Bank and Savings (`ASSET`), Card (`LIABILITY`, `CREDIT_CARD`), Food (`EXPENSE`) with Groceries made its child (`parentId`, set directly).

| Date | From → To | ₹ | Note |
|---|---|---|---|
| 01-01 | Opening Balance → Bank | 1,00,000 | system income, excluded |
| 01-02 | Card → Opening Balance Contra | 20,000 | Card opens owing 20,000; system expense, excluded |
| 01-05 / 02-05 / 03-05 | Salary → Bank | 50,000 each | |
| 01-10 | Bank → Groceries | 4,000 | |
| 01-12 | Bank → Food | 1,000 | direct to the parent |
| 01-15 | Bank → Dining | 1,500 | |
| 01-20, 02-20, 03-08 | Bank → Rent | 15,000 each | |
| 01-25 | Bank → Card | 5,000 | card bill: not spending |
| 02-07 | Interest → Bank | 300 | |
| 02-10 | Card → Groceries | 2,500 | card spend counts |
| 02-12 | Groceries → Bank | 500 | refund |
| 02-18 | Bank → Savings | 10,000 | transfer: not spending |
| 03-09 | Bank → Dining | 6,000 | |
| 03-12 | Dining → Bank | 9,000 | refund larger than the spend |
| 03-15 | Realised Gain → Bank | 2,000 | |
| 03-16 | Bank → Realised Loss | 800 | |
| 03-20 | Bank → Groceries | 99,999 | **soft-deleted** |

Worked figures: income by month 5,000,000 / 5,030,000 / 5,200,000, total 15,230,000; spending by month 2,150,000 / 1,700,000 / 1,280,000, total 5,130,000; net saved 2,850,000 / 3,330,000 / 3,920,000, total 10,100,000. Bank: Jan opening 0, in 15,000,000, out 2,650,000, closing 12,350,000; Feb opening 12,350,000, in 5,080,000, out 2,500,000, closing 14,930,000; Mar opening 14,930,000, in 6,100,000, out 2,180,000, closing 18,850,000. Card: Jan {0, in 500,000, out 2,000,000, closing −1,500,000}; Feb {−1,500,000, 0, 250,000, −1,750,000}; Mar {−1,750,000, 0, 0, −1,750,000}.

**Scenario N (holdings).** Extra nodes: Bank (`ASSET`), Card (`LIABILITY`), Gold (`INVESTMENT`, `QUANTITY`, gram, FIFO), Fund (`INVESTMENT`, `CONTRIBUTION_ONLY`).

| Date | Event | ₹ |
|---|---|---|
| 01-02 | Opening Balance → Bank | 2,00,000 |
| 01-02 | Card → Opening Balance Contra | 20,000 |
| 01-10 | Bank → Gold, quantity 10 g | 70,000 |
| 01-20 | Bank → Fund | 10,000 |
| 02-10 | Bank → Gold, quantity 5 g | 37,000 |
| 02-15 | Gold price per gram | 7,500 |
| 03-05 | Gold price per gram | 7,600 |
| 03-05 | `sellInvestment` 8 g of Gold into Bank, proceeds | 60,800 (FIFO takes 8 g of the first lot: cost 56,000, gain 4,800) |

There is deliberately **no price before 02-15**, so January is not valued. Worked month-ends (paise): Jan 31 assets 12,000,000, investments 1,000,000 (Fund only), owed 2,000,000, total 11,000,000, partial, Gold unvalued (`NO_PRICE`). Feb 28 assets 8,300,000, investments 12,250,000 (Gold 15 g × 7,500 = 11,250,000, Fund 1,000,000), owed 2,000,000, total 18,550,000. Mar 31 assets 14,380,000, investments 6,320,000 (Gold 7 g × 7,600 = 5,320,000), owed 2,000,000, total 18,700,000. Gold invested (balance): 7,000,000 / 10,700,000 / 5,100,000; Gold gain: — / 550,000 / 220,000; realised in March 480,000.

---

### Task 1: Dates and periods

**Files:**
- Modify: `src/domain/calendar-date.ts`, `src/domain/calendar-date.test.ts`
- Create: `src/domain/periods.ts`, `src/domain/periods.test.ts`

**Interfaces:**
- Consumes: `CalendarDate`, `calendarDate`, `monthRange`, `financialYearRange`, `daysBetween`, `compareDates` from `calendar-date.ts`.
- Produces:
  ```ts
  // calendar-date.ts
  export function addDays(date: CalendarDate, days: number): CalendarDate
  // periods.ts
  export type RangeChoice =
    | { kind: "month"; year: number; month: number }
    | { kind: "fy"; startYear: number }
    | { kind: "last12" }
    | { kind: "custom"; from: CalendarDate; to: CalendarDate }
  export class ReportRangeError extends Error {}
  export const MAX_RANGE_DAYS = 3660
  export interface ResolvedRange { from: CalendarDate; to: CalendarDate; requestedTo: CalendarDate; clampedToToday: boolean }
  export function resolveRange(choice: RangeChoice, today: CalendarDate, fyStartMonth: number): ResolvedRange
  export function parseRangeChoice(params: { range?: string; from?: string; to?: string }): RangeChoice
  export function rangeParams(choice: RangeChoice): { range: string; from?: string; to?: string }
  export interface Bucket { key: string; from: CalendarDate; to: CalendarDate; partial: boolean }
  export function monthBuckets(range: { from: CalendarDate; to: CalendarDate }): Bucket[]
  export function dayBuckets(range: { from: CalendarDate; to: CalendarDate }): Bucket[]
  export function clipToHistory(range: { from: CalendarDate; to: CalendarDate }, firstTransaction: CalendarDate | null): { from: CalendarDate; to: CalendarDate; historyBegins: CalendarDate | null }
  export function selectableMonths(first: CalendarDate, today: CalendarDate): { year: number; month: number }[]   // newest first
  export function selectableFinancialYears(first: CalendarDate, today: CalendarDate, fyStartMonth: number): number[] // start years, newest first
  ```
  URL grammar: `range` is `last12`, `month-YYYY-MM`, `fy-YYYY` (the year the FY starts) or `custom` (with `from` and `to` as `YYYY-MM-DD`); absent means `last12`; anything else throws `ReportRangeError`. `Bucket.key` is `YYYY-MM` (month) or `YYYY-MM-DD` (day).

- [ ] **Step 1: Write the failing tests** (UTC midnight maths, so they run unchanged in both timezone passes)
  - `addDays`: `("2026-02-28", 1)` → `"2026-03-01"`; `("2024-02-28", 1)` → `"2024-02-29"`; `("2026-01-01", -1)` → `"2025-12-31"`.
  - `resolveRange` with today `2026-10-27`, FY start 4: month 2026-04 → `2026-04-01`…`2026-04-30`, not clamped; month 2026-10 → to `2026-10-27`, `requestedTo` `2026-10-31`, clamped; fy 2025 → `2025-04-01`…`2026-03-31`; fy 2026 → from `2026-04-01`, to `2026-10-27`, clamped; with FY start 1, fy 2025 → `2025-01-01`…`2025-12-31`; last12 → `2025-11-01`…`2026-10-27` (today `2026-01-15` → from `2025-02-01`).
  - `resolveRange` throws `ReportRangeError` for custom `2026-03-01`…`2026-01-01` (message contains "before"), for `2000-01-01`…`2026-01-01` (more than 10 years), and for a custom range whose `from` is after today (message contains "after today").
  - `parseRangeChoice({})` → `{kind:"last12"}`; `{range:"month-2026-04"}` → month; `{range:"custom", from:"2026-01-01", to:"2026-03-31"}` → custom; each of `{range:"month-2026-13"}`, `{range:"fy-abc"}`, `{range:"custom", from:"2026-01-01"}`, `{range:"bogus"}`, `{range:"month-2026-4"}`, `{range:"custom", from:"2026-02-30", to:"2026-03-01"}` throws `ReportRangeError`. `rangeParams` round-trips every valid choice.
  - `monthBuckets({from:"2026-01-15", to:"2026-03-10"})` → keys `2026-01` (15th–31st, partial), `2026-02` (whole, not partial), `2026-03` (1st–10th, partial); `2024-02` ends `2024-02-29`; a one-day range gives one partial bucket; an exact whole month gives `partial: false`. `dayBuckets({from:"2026-02-27", to:"2026-03-02"})` → four keys `2026-02-27`, `2026-02-28`, `2026-03-01`, `2026-03-02`.
  - `clipToHistory`: first `2026-03-18` with range `2025-11-01`…`2026-10-27` → from `2026-03-01`, `historyBegins` `2026-03-18`; first earlier than the range start → range unchanged, `historyBegins: null`; first `null` → unchanged, `null`; first after `to` → unchanged, `null`.
  - `selectableMonths("2026-02-10","2026-04-02")` → `[{2026,4},{2026,3},{2026,2}]`; `selectableFinancialYears("2025-11-05","2026-10-27",4)` → `[2026, 2025]`.
- [ ] **Step 2: Run to verify failure** — `sh scripts/test-tz.sh src/domain/periods.test.ts src/domain/calendar-date.test.ts`; expected: FAIL (missing exports).
- [ ] **Step 3: Implement** the signatures above in `calendar-date.ts` and `periods.ts` using UTC-component arithmetic (`toDbDate`/`fromDbDate`), never local time. `resolveRange` clamps `to = min(requestedTo, today)`.
- [ ] **Step 4: Run to verify pass** — same command, both passes green; then `bunx tsc --noEmit && bun run lint`.
- [ ] **Step 5: Commit** — `git add src/domain && git commit -m "feat(domain): report periods, buckets and range parsing"`

---

### Task 2: Report maths

**Files:**
- Create: `src/domain/reports.ts`, `src/domain/reports.test.ts`

**Interfaces:**
- Consumes: `Bucket` from `periods.ts`; `Paise`; `SystemNodeRole` from `ledger-kind.ts`.
- Produces:
  ```ts
  export interface FlowNode { id: string; name: string; kind: "INCOME_SOURCE" | "EXPENSE"; parentId: string | null; systemRole: SystemNodeRole | null; archived: boolean }
  export function isReportable(node: { systemRole: SystemNodeRole | null }): boolean   // false for OPENING_BALANCE and OPENING_BALANCE_CONTRA
  export interface Move { nodeId: string; bucket: string; inPaise: Paise; outPaise: Paise }
  export function flowOf(kind: "INCOME_SOURCE" | "EXPENSE", move: { inPaise: Paise; outPaise: Paise }): Paise // income: out − in; spending: in − out
  export interface CashFlowBucket { bucket: Bucket; incomePaise: Paise; spendingPaise: Paise; savedPaise: Paise }
  export interface CashFlow { buckets: CashFlowBucket[]; incomePaise: Paise; spendingPaise: Paise; savedPaise: Paise; gainPaise: Paise; lossPaise: Paise }
  export function cashFlow(buckets: readonly Bucket[], nodes: readonly FlowNode[], moves: readonly Move[]): CashFlow
  export interface RankedRow { id: string; name: string; paise: Paise; directPaise: Paise; shareTenths: bigint | null; archived: boolean; fromSales: boolean; children: RankedRow[] }
  export interface Ranked { rows: RankedRow[]; refunds: RankedRow[]; totalPaise: Paise }
  export function rankFlows(kind: "INCOME_SOURCE" | "EXPENSE", nodes: readonly FlowNode[], moves: readonly Move[]): Ranked
  export function shareTenths(part: Paise, whole: Paise): bigint | null
  export interface Step { openingPaise: Paise; inPaise: Paise; outPaise: Paise; closingPaise: Paise }
  export function stepBalances(buckets: readonly Bucket[], openings: ReadonlyMap<string, Paise>, moves: readonly Move[]): Map<string, Map<string, Step>> // bucket key → node id → step
  export interface GrowthNodePoint { nodeId: string; investedPaise: Paise; valuePaise: Paise | null; stale: boolean }
  export interface PortfolioPoint { investedPaise: Paise; valuePaise: Paise; gainPaise: Paise; covered: number; total: number; unvaluedNodeIds: string[]; stale: boolean }
  export function portfolioPoint(nodes: readonly GrowthNodePoint[]): PortfolioPoint
  ```
  Rules. `cashFlow` ignores non-reportable nodes and moves whose bucket is not in `buckets`; `gainPaise`/`lossPaise` are the Realised Gain / Realised Loss shares of income / spending. `rankFlows`: aggregates every move per reportable node; a node with no moves is absent, one with moves is kept even at zero; a top-level row is a node with no parent **in `nodes`** (a child whose parent is missing or of the other kind is top-level), its `paise` is its own plus its children's, `directPaise` its own, children ordered like rows; rows ordered by `paise` descending, ties by name (`localeCompare`) then id; a top-level row with `paise < 0` goes to `refunds` (most negative first); `shareTenths` of a row is `shareTenths(row.paise, Σ rows.paise)` (the positive rows only), `null` for refunds; `totalPaise` is the sum of rows and refunds; `fromSales` is true for `REALISED_GAIN`/`REALISED_LOSS`. `shareTenths(part, whole)` is half-up of `part × 1000 ÷ whole` (so `852` is 85.2%), `null` when `whole <= 0n` or `part < 0n`. `stepBalances`: a node's opening of the first bucket is `openings.get(id) ?? 0n`, each next opening is the previous closing, a bucket with no move for a node is `{closing = opening, in 0, out 0}`, and every node in `openings` or in `moves` has a step in every bucket. `portfolioPoint`: `investedPaise` sums **all** nodes, `valuePaise` sums valued ones, `gainPaise` = Σ(value − invested) over valued nodes only (like with like), `covered` counts valued nodes, `stale` is true if any valued node is stale.

- [ ] **Step 1: Write the failing tests** (nodes `rent`, `food` parent, `groceries` child of food, `dining`, `loss` = REALISED_LOSS, `contra` = OPENING_BALANCE_CONTRA, `salary`, `interest`, `gain` = REALISED_GAIN, `opening` = OPENING_BALANCE; moves are Scenario F aggregated over the range, in paise)
  - `isReportable`: false for `OPENING_BALANCE`, `OPENING_BALANCE_CONTRA`; true for `null`, `REALISED_GAIN`, `REALISED_LOSS`.
  - `flowOf("EXPENSE", {in:250000n,out:50000n})` = `200000n`; `flowOf("INCOME_SOURCE", {in:0n,out:5000000n})` = `5000000n`.
  - `cashFlow` over buckets `2026-01`, `2026-02`, `2026-03` with moves: salary out 5,000,000 in each month; interest out 30,000 in Feb; gain out 200,000 in Mar; opening out 10,000,000 in Jan; Jan expense ins: groceries 400,000, food 100,000, dining 150,000, rent 1,500,000, contra 2,000,000; Feb: groceries in 250,000 out 50,000, rent in 1,500,000; Mar: rent in 1,500,000, dining in 600,000 out 900,000, loss in 80,000. Expect income `5000000n/5030000n/5200000n` (total `15230000n`), spending `2150000n/1700000n/1280000n` (total `5130000n`), saved `2850000n/3330000n/3920000n` (total `10100000n`), `gainPaise` `200000n`, `lossPaise` `80000n`.
  - `rankFlows("EXPENSE", …)` with whole-range moves: rent in 4,500,000; food in 100,000; groceries in 650,000 out 50,000; dining in 750,000 out 900,000; loss in 80,000; contra in 2,000,000. Expect `rows`: Rent `4500000n` share `852n`; Food `700000n`, `directPaise` `100000n`, share `133n`, one child Groceries `600000n`; Realised Loss `80000n`, share `15n`, `fromSales` true. `refunds`: Dining `-150000n`, share `null`. `totalPaise` `5130000n`. Contra absent.
  - `rankFlows("INCOME_SOURCE", …)`: salary out 15,000,000; interest out 30,000; gain out 200,000; opening out 10,000,000 → rows Salary `15000000n` share `985n`, Realised Gain `200000n` share `13n`, Interest `30000n` share `2n`; total `15230000n`; shares add to `1000n`.
  - Parent edges: an archived child still counts and is flagged `archived`; a child whose `parentId` is a node not in `nodes` is a top-level row; a refund-only child (negative) inside a positive parent is listed among the children with its negative `paise` and lowers the parent's; a parent with children but no direct moves has `directPaise` `0n`; two rows with equal `paise` order by name then id; no rows at all → `rows: []`, `refunds: []`, `totalPaise: 0n`, and no share anywhere (no division by zero).
  - `shareTenths`: `(1n,8n)` → `125n`; `(1n,3n)` → `333n`; `(1n,6n)` → `167n`; `(1n,16n)` → `63n` (half up); `(5n,0n)` → `null`; `(-1n,5n)` → `null`; `(2n**60n, 2n**61n)` → `500n`; `(7n*10n**24n, 9n*10n**24n)` → `778n` (exact bigint, no overflow).
  - `stepBalances` for Bank over the three months with `openings = {bank: 0n}` and moves Jan in 15,000,000 out 2,650,000; Feb in 5,080,000 out 2,500,000; Mar in 6,100,000 out 2,180,000 → Jan `{0, 15000000, 2650000, 12350000}`, Feb `{12350000, 5080000, 2500000, 14930000}`, Mar `{14930000, 6100000, 2180000, 18850000}`. A node only in `openings` (balance 700n) appears in every bucket with in/out `0n` and closing `700n`; a node with a negative opening (`-2000000n`) carries it.
  - `portfolioPoint`: `[Gold {7000000n, null, false}, Fund {1000000n, 1000000n, false}]` → invested `8000000n`, value `1000000n`, gain `0n`, covered `1`, total `2`, unvalued `["gold"]` (use the ids given); `[Gold {5100000n, 5320000n, false}, Fund {1000000n, 1000000n, false}]` → invested `6100000n`, value `6320000n`, gain `220000n`, covered `2`; one stale valued node → `stale: true`; an empty list → zeros, covered `0`, total `0`.
- [ ] **Step 2: Run to verify failure** — `sh scripts/test-tz.sh src/domain/reports.test.ts`; expected: FAIL.
- [ ] **Step 3: Implement** the signatures in `src/domain/reports.ts`. `shareTenths` rounds half-up as `(part*2000n + whole) / (2n*whole)`. Keep it free of Prisma, Next and server imports.
- [ ] **Step 4: Run to verify pass**, both passes; `bunx tsc --noEmit && bun run lint`.
- [ ] **Step 5: Commit** — `git add src/domain/reports.ts src/domain/reports.test.ts && git commit -m "feat(domain): report aggregation, ranking and running balances"`

---

### Task 3: Transactions screen — multi-node filter, `flow` filter, filtered total

**Files:**
- Modify: `src/lib/schemas/transaction.ts`, `src/lib/schemas/transaction.test.ts`, `src/lib/transaction-list-view.ts`, `src/server/repositories/transaction-repository.ts`, `src/server/services/transaction-list.ts`, `src/app/transactions/filters.tsx`, `src/app/transactions/transaction-workspace.tsx`
- Create: `src/app/transactions/filtered-total.tsx`
- Test: `tests/server/repositories/transactions.test.ts`, `tests/server/repositories/isolation.test.ts`, `tests/server/transaction-list.test.ts`

**Interfaces:**
- Consumes: `isReportable` (Task 2), `listAllNodes` (node service), `filterConditions` (private to the repository).
- Produces:
  ```ts
  // schemas/transaction.ts: ListFilter.node becomes string[] | undefined (comma-separated in the URL, ids de-duplicated, at most 50),
  // ListFilter.flow is "income" | "spending" | undefined ("" is undefined; anything else is a field issue on `flow`)
  // transaction-list-view.ts
  FilterValues.flow: string            // "flow" is added to FILTER_KEYS
  TransactionScreen.netTotal: { paise: string } | null
  // transaction-repository.ts
  export function sumNetIntoNodes(userId: string, filter: TransactionFilter & { nodeIds: string[] }): Promise<Paise>
  ```
  `sumNetIntoNodes` counts live entries only (it ignores `includeDeleted`), applies every other filter field, and returns Σ amount **into** the set from outside it − Σ amount **out of** it to outside it (an entry with both ends inside the set cancels); one aggregate per direction in SQL, reusing `filterConditions`. The service resolves `flow` to the user's reportable nodes of that kind (`income` → `INCOME_SOURCE`, `spending` → `EXPENSE`, archived included, `isReportable` only), intersects with `node` when both are given, and passes the result as `nodeIds`; a flow that resolves to no node yields an empty list and `netTotal.paise` `"0"`. `netTotal` is `null` when neither `node` nor `flow` is set or the filter does not parse.

- [ ] **Step 1: Write the failing tests**
  - Schema: `node: "a,b,a"` parses to `["a","b"]`; 51 distinct ids is an issue on `node`; `node: ""` is `undefined`; `flow: "income"` and `"spending"` parse; `flow: "bogus"` is an issue on `flow`; `flow: ""` is `undefined`; the existing single-id cases still pass (`"abc"` → `["abc"]`).
  - Repository (world: Bank, Food, Clothes, Salary; Bank→Food 500, Bank→Clothes 300, Food→Clothes 100, Food→Bank 50, and a soft-deleted Bank→Food 999): `sumNetIntoNodes({nodeIds:[food]})` = `350n` (500 − 100 − 50); `[food, clothes]` = `750n` (800 in, 50 out, the Food→Clothes 100 cancels); `[food, clothes]` with `minAmount: 200n` = `800n`; a foreign user's `userId` with the same ids = `0n`.
  - Isolation test: `sumNetIntoNodes(otherUser.id, {nodeIds:[food.id]})` returns `0n` and `findTransactions` with a multi-id `nodeIds` containing a foreign id returns none of the foreign rows.
  - Service (`loadTransactionScreen`, query `{ from: "", to: "" }` plus the keys below; nodes Salary, Bank, Food, Opening Balance and Opening Balance Contra with their `systemRole`): `flow=spending` after Bank→Food 1,000 / Food→Bank 200 / Bank→Contra 5,000 lists the two Food entries only and `netTotal.paise` is `"80000"`; `flow=income` after Salary→Bank 3,000 / Opening Balance→Bank 9,000 lists the Salary entry only and `netTotal.paise` is `"-300000"`; `node=<food>,<bank>` lists entries touching either and an entry between them cancels; a bad `flow` leaves the list empty with `problems.flow`; no node or flow gives `netTotal: null`; `deleted=1` still totals live entries only.
- [ ] **Step 2: Run to verify failure** — `sh scripts/test-tz.sh src/lib/schemas/transaction.test.ts tests/server/repositories/transactions.test.ts tests/server/repositories/isolation.test.ts tests/server/transaction-list.test.ts`; expected: FAIL.
- [ ] **Step 3: Implement** the schema change (a `blank()` string split on commas, trimmed, de-duplicated, `max(50)`), `flow`, `sumNetIntoNodes`, the service resolution and `netTotal`. Compile errors point at every `filter.node` caller (the `loadMore` action path takes the same fields). `Filters`: when `filter.node` holds more than one id, the Involving select gets a leading selected option whose value is the comma-joined list and whose label is `"{n} ledgers together"`, so applying another filter keeps it and choosing "Any account or ledger" clears it; add a "Counted as" select (Any, Income, Spending) bound to `flow`. `FilteredTotal` shows `Net into these ledgers ₹X` when the figure is zero or more and `Net out of these ledgers ₹X` (absolute value) when negative, using `formatPaiseText`, and "Counts live entries only." when `deleted` is on; render it in the workspace between the filters and the list, only when `netTotal` is non-null.
- [ ] **Step 4: Run to verify pass** — the Step 2 command, then `bun run test` (the existing transaction, balances and isolation tests must still pass), `bunx tsc --noEmit`, `bun run lint`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: multi-ledger and flow filters with a filtered total on the transactions screen"`

---

### Task 4: Report repository and shared scenarios

**Files:**
- Modify: `src/server/repositories/user-repository.ts`
- Create: `src/server/repositories/report-repository.ts`, `tests/server/reports/scenarios.ts`, `tests/server/repositories/reports.test.ts`
- Modify: `tests/server/repositories/isolation.test.ts`

**Interfaces:**
- Consumes: `prisma`, `Prisma.sql` as `sumBalances` uses them; `CalendarDate`, `LedgerKind`, `Paise`.
- Produces:
  ```ts
  // user-repository.ts
  export function findFinancialYearStartMonth(userId: string): Promise<number>   // throws UserNotFoundError
  // report-repository.ts
  export interface MoveRow { nodeId: string; bucket: string; inPaise: Paise; outPaise: Paise }
  export function findMoves(userId: string, query: { from: CalendarDate; to: CalendarDate; bucket: "day" | "month"; kinds?: LedgerKind[]; nodeIds?: string[] }): Promise<MoveRow[]>
  export interface RealisedRow { nodeId: string; bucket: string; gainPaise: Paise; lossPaise: Paise }
  export function findRealisedByMonth(userId: string, range: { from: CalendarDate; to: CalendarDate }): Promise<RealisedRow[]>
  export function findFirstTransactionDate(userId: string): Promise<CalendarDate | null>
  export function countLiveTransactionsAfter(userId: string, after: CalendarDate): Promise<number>
  // tests/server/reports/scenarios.ts
  type Registry = ReturnType<typeof createRegistry>   // from tests/server/repositories/fixtures.ts
  export async function flowScenario(registry: Registry): Promise<{ user: User; nodes: Record<string, LedgerNode> }>
  export async function holdingsScenario(registry: Registry): Promise<{ user: User; nodes: Record<string, LedgerNode> }>
  ```
  `findMoves`: live transactions dated in `[from, to]` only; for each node the user owns that matches `kinds`/`nodeIds`, `inPaise` = Σ amount into it, `outPaise` = Σ out of it, grouped by `bucket` (`YYYY-MM` or `YYYY-MM-DD`); nodes with no move in the range produce no row; every query puts `userId` on both the node and the transaction side. `findRealisedByMonth`: legs of live `DISPOSAL` groups, attributed to the `INVESTMENT` node that is the source of the group's cost-basis leg: `gainPaise` = Σ legs out of a `REALISED_GAIN` node, `lossPaise` = Σ legs into a `REALISED_LOSS` node, bucketed `YYYY-MM` by the leg's day. `findFirstTransactionDate`: earliest live `occurredAt`, or `null`. `countLiveTransactionsAfter`: live entries dated strictly after `after`.

- [ ] **Step 1: Build `scenarios.ts`** from the two tables above (use `createRegistry`, `seedAccountNodes`, `recordTransaction`, `sellInvestment`, `recordPrice`; the soft-deleted row is created then soft-deleted through the repository). Both return the user and a name → node map. This file has no test of its own; Steps 2–4 use it.
- [ ] **Step 2: Write the failing tests**
  - `findMoves` on Scenario F, `{from:"2026-01-01", to:"2026-03-31", bucket:"month", kinds:["INCOME_SOURCE","EXPENSE"]}`: contains Salary `2026-01` out `5000000n` in `0n`; Rent `2026-02` in `1500000n`; Groceries `2026-02` in `250000n` out `50000n`; Dining `2026-03` in `600000n` out `900000n`; Opening Balance `2026-01` out `10000000n`; **no** Groceries row for `2026-03` (the deleted entry); no row for Utilities (no moves).
  - Bank, `nodeIds:[bank]`, month: Jan in `15000000n` out `2650000n`; Feb in `5080000n` out `2500000n`; Mar in `6100000n` out `2180000n`. Day bucket for `from:"2026-01-05", to:"2026-01-05"`: one row `2026-01-05`, in `5000000n`. A range ending before the first entry gives `[]`.
  - `findRealisedByMonth` on Scenario N over Jan–Mar: exactly `[{nodeId: gold.id, bucket:"2026-03", gainPaise:480000n, lossPaise:0n}]`. Separate world (Gold: 10 g for 70,000 on 2026-01-10, sold 10 g for 62,000 on 2026-03-20): `[{gold, "2026-03", 0n, 800000n}]`. A break-even sale produces no row.
  - `findFirstTransactionDate`: Scenario F → `"2026-01-01"`; a user with none → `null`; a user whose only entry is soft-deleted → `null`.
  - `countLiveTransactionsAfter(userId, "2026-03-31")` is `0` for Scenario F, `1` after adding one entry dated today + 10 days, still `1` after also adding a soft-deleted one.
  - `findFinancialYearStartMonth` returns `4` for a new user, the stored value when changed, and throws `UserNotFoundError` for an unknown id.
  - Isolation: for a foreign user id with Scenario F's node ids, `findMoves`, `findRealisedByMonth` return `[]`, `findFirstTransactionDate` returns that user's own date or `null`, and `countLiveTransactionsAfter` counts only that user's rows.
- [ ] **Step 3: Run to verify failure** — `sh scripts/test-tz.sh tests/server/repositories/reports.test.ts tests/server/repositories/isolation.test.ts`; expected: FAIL.
- [ ] **Step 4: Implement** the five functions with `$queryRaw` and `Prisma.sql` as `sumBalances` does: cast sums to text and parse with `BigInt`; format the bucket with `to_char("occurredAt", 'YYYY-MM')` / `'YYYY-MM-DD'`. For the realised query, join each realised leg to a sibling leg in the same group whose `fromNodeId` is an `INVESTMENT` node (`MIN` of it, one per group).
- [ ] **Step 5: Run to verify pass**, both timezone passes, then `bunx tsc --noEmit && bun run lint`.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(server): report aggregates and the shared report scenarios"`

---

### Task 5: Flow reports — cash flow, spending, income

**Files:**
- Create: `src/lib/report-view.ts`, `src/lib/report-drill.ts`, `src/lib/report-drill.test.ts`, `src/server/services/report-service.ts`, `tests/server/reports/flow-reports.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4; `todayFor`, `listAllNodes`; `loadTransactionScreen` (in the test, as the oracle).
- Produces:
  ```ts
  // report-drill.ts
  export interface Drill { node?: readonly string[]; flow?: "income" | "spending"; kind?: LedgerKind; from: CalendarDate; to: CalendarDate }
  export function transactionsHref(drill: Drill): string   // "/transactions?" + node, flow, kind, from, to in that order, omitting the unset ones
  // report-view.ts (every amount is paise text)
  export interface RangeView { from: CalendarDate; to: CalendarDate; clampedToToday: boolean; historyBegins: CalendarDate | null; futureCount: number }
  export interface BucketView { key: string; from: CalendarDate; to: CalendarDate; partial: boolean }
  export interface CashFlowView {
    range: RangeView; empty: boolean
    buckets: { bucket: BucketView; incomePaise: string; spendingPaise: string; savedPaise: string; incomeDrill: Drill; spendingDrill: Drill }[]
    totals: { incomePaise: string; spendingPaise: string; savedPaise: string; gainPaise: string; lossPaise: string; incomeDrill: Drill; spendingDrill: Drill }
  }
  export interface RankedRowView { id: string; name: string; paise: string; directPaise: string; shareTenths: number | null; archived: boolean; fromSales: boolean; drill: Drill; children: RankedRowView[] }
  export interface RankedView { range: RangeView; empty: boolean; kind: "INCOME_SOURCE" | "EXPENSE"; rows: RankedRowView[]; refunds: RankedRowView[]; totalPaise: string; totalDrill: Drill }
  // report-service.ts
  export async function loadCashFlow(userId: string, choice: RangeChoice): Promise<CashFlowView>
  export async function loadRanked(userId: string, choice: RangeChoice, kind: "INCOME_SOURCE" | "EXPENSE"): Promise<RankedView>
  ```
  Rules. `empty` is true only when the user has no live transaction at all; then `buckets` is `[]`. `loadCashFlow` clips the range with `clipToHistory` (so a range starting before the user's first entry starts at that month and `historyBegins` says why); `loadRanked` does not clip. `futureCount` is `countLiveTransactionsAfter(today)` when the range ends today, else `0`. A bucket's drills are `{flow, from, to}` over the bucket's days; the totals' drills cover the range; a ranked row's drill is `{node:[row id, ...children ids], from, to}` over the range; `totalDrill` is `{flow, range}` with `income` for `INCOME_SOURCE` and `spending` for `EXPENSE`. A bad range throws `ReportRangeError` from `resolveRange` (the page handles it).

- [ ] **Step 1: Write the failing tests**
  - `transactionsHref({node:["a","b"], from:"2026-01-01", to:"2026-01-31"})` is exactly `/transactions?node=a%2Cb&from=2026-01-01&to=2026-01-31`; `{flow:"spending", from, to}` is `/transactions?flow=spending&from=…&to=…`; `{kind:"ASSET", from, to}` carries `kind=ASSET`.
  - Scenario F, custom 2026-01-01…2026-03-31, `loadCashFlow`: bucket income `"5000000"`, `"5030000"`, `"5200000"`; spending `"2150000"`, `"1700000"`, `"1280000"`; saved `"2850000"`, `"3330000"`, `"3920000"`; totals income `"15230000"`, spending `"5130000"`, saved `"10100000"`, gain `"200000"`, loss `"80000"`; no bucket partial; the January spending drill is `{flow:"spending", from:"2026-01-01", to:"2026-01-31"}`. (The card bill, the Savings transfer, Opening Balance, Contra and the deleted entry are in none of these.)
  - `loadRanked` EXPENSE: rows in order Rent `"4500000"` share `852`; Food `"700000"` direct `"100000"` share `133` with child Groceries `"600000"`; Realised Loss `"80000"` share `15` `fromSales`; refunds `[Dining "-150000"]` share `null`; total `"5130000"`; Food's drill `node` is `[food.id, groceries.id]`. INCOME_SOURCE: Salary `"15000000"` share `985`; Realised Gain `"200000"` `fromSales` share `13`; Interest `"30000"` share `2`; total `"15230000"`.
  - **Reconciliation** (the milestone's exit criterion): for every bucket of `loadCashFlow` and for the totals, `loadTransactionScreen(userId, {flow, from, to})` `netTotal.paise` equals the spending figure, and its negation equals the income figure; for every ranked row and refund row, `loadTransactionScreen(userId, {node: ids.join(","), from, to})` `netTotal.paise` equals `row.paise` (expense) or its negation (income), and the listed entries are exactly the ones touching those nodes.
  - Archiving Rent leaves its row with `archived: true` and the total unchanged. A user whose only entry is dated 2026-02-10 with range 2025-11-01…2026-03-31: first bucket `2026-02`, `range.historyBegins` `"2026-02-10"`. A custom range ending today + 30 days: `range.to` is today, `clampedToToday` true, and with one live entry dated today + 10 days `futureCount` is `1` and the entry is in no figure.
  - Degenerate: a user with no transactions gets `empty: true`, `buckets: []`; a range with no activity (custom 2025-01-01…2025-01-31 for Scenario F) gives one zero bucket, `rows: []`, `totalPaise` `"0"`, no `NaN` anywhere in `JSON.stringify` of the view; a bad range (`2026-03-01`…`2026-01-01`) rejects with `ReportRangeError`.
  - **Timezone** (parametrised over `Pacific/Kiritimati` and `Pacific/Pago_Pago`): set the user's `timezone`, call `loadCashFlow` with `{kind:"last12"}`; `range.to` equals `todayIn(thatZone)`.
- [ ] **Step 2: Run to verify failure** — `sh scripts/test-tz.sh src/lib/report-drill.test.ts tests/server/reports/flow-reports.test.ts`; expected: FAIL.
- [ ] **Step 3: Implement** the views, `transactionsHref` (use `URLSearchParams`) and the two loaders: read settings (`todayFor`, `findFinancialYearStartMonth`), resolve and clip the range, `findMoves` with `kinds ["INCOME_SOURCE","EXPENSE"]` and the bucketing, map nodes to `FlowNode`, call `cashFlow` / `rankFlows`, serialise with `serialisePaise`.
- [ ] **Step 4: Run to verify pass**, both passes; `bunx tsc --noEmit && bun run lint`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(server): cash flow, spending and income reports with drill-throughs"`

---

### Task 6: Balance reports — net worth, account history, investment growth

**Files:**
- Modify: `src/lib/report-view.ts`, `src/server/services/report-service.ts`
- Test: `tests/server/reports/balance-reports.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5; `sumBalances`, `netWorth`, `readValuationInputs`, `valuationStatesFrom`, `NotValuedReason` and `NOT_VALUED_COPY` from `investment-view`; `NotFoundError` from `repositories/errors`.
- Produces:
  ```ts
  export interface NetWorthPointView {
    bucket: BucketView; asOf: CalendarDate
    assetsPaise: string; investmentsPaise: string; liabilitiesPaise: string; totalPaise: string
    partial: boolean; unvalued: { nodeId: string; name: string; reason: NotValuedReason }[]; staleNames: string[]
    movementDrill: Drill; assetsDrill: Drill; investmentsDrill: Drill; liabilitiesDrill: Drill   // the month's entries: no kind / ASSET / INVESTMENT / LIABILITY
  }
  export interface NetWorthReportView { range: RangeView; empty: boolean; points: NetWorthPointView[] }
  export interface AccountHistoryView {
    range: RangeView; empty: boolean; granularity: "day" | "month"
    accounts: { id: string; name: string; kind: "ASSET" | "LIABILITY"; archived: boolean }[]
    selected: { id: string; name: string; kind: "ASSET" | "LIABILITY"; archived: boolean } | null
    steps: { bucket: BucketView; openingPaise: string; inPaise: string; outPaise: string; closingPaise: string; drill: Drill }[]
  }
  export interface GrowthPointView {
    bucket: BucketView; asOf: CalendarDate
    investedPaise: string; valuePaise: string | null; gainPaise: string | null; realisedPaise: string
    stale: boolean; covered: { covered: number; total: number } | null; unvaluedNames: string[]; drill: Drill
  }
  export interface InvestmentGrowthView {
    range: RangeView; empty: boolean
    investments: { id: string; name: string; archived: boolean }[]
    selected: { id: string; name: string } | null     // null = the whole portfolio
    points: GrowthPointView[]
  }
  export async function loadNetWorthReport(userId: string, choice: RangeChoice, options?: { inputs?: ValuationInputs }): Promise<NetWorthReportView>
  export async function loadAccountHistory(userId: string, choice: RangeChoice, nodeId: string | undefined): Promise<AccountHistoryView>
  export async function loadInvestmentGrowth(userId: string, choice: RangeChoice, nodeId: string | undefined): Promise<InvestmentGrowthView>
  ```
  Rules. Points sit at `bucket.to` (the last one is today when the range reaches it). Net worth: openings from `sumBalances(addDays(range.from, -1))`, monthly `findMoves` for `ASSET`/`INVESTMENT`/`LIABILITY`, `stepBalances`, then per bucket the existing `netWorth(balances, valuationStatesFrom(inputs, bucket.to).valuations)`; `unvalued` from that call's `unvalued`, `staleNames` from `priced` entries with `stale`; liabilities as the positive amount owed. Account history: `nodeId` undefined selects the first non-archived `ASSET`, or `null` when none; an id that is not the user's, or not an `ASSET`/`LIABILITY`, throws `NotFoundError`; `granularity` is `"day"` when the range covers 93 days or fewer (inclusive) and `"month"` otherwise; each step's drill is `{node:[id], from, to}` over the bucket. Investment growth: per node `invested` is its closing balance, `value` is `valuationStatesFrom` for a lot-mode node and `invested` for a `CONTRIBUTION_ONLY` one, `gain = value − invested`, `realised` = gain − loss from `findRealisedByMonth` for that node and month; portfolio points use `portfolioPoint` (`covered` set, `valuePaise`/`gainPaise` over valued nodes, `unvaluedNames`); a not-valued node point has `valuePaise` and `gainPaise` `null` (a gap, never zero); `nodeId` must be an `INVESTMENT` node of the user or `NotFoundError`; a drill is `{node:[id] or all investment ids, from, to}` over the bucket. Net worth and growth are clipped with `clipToHistory` and `empty`/`buckets` follow Task 5's rules.

- [ ] **Step 1: Write the failing tests** (Scenario N for net worth and growth, Scenario F for account history; custom 2026-01-01…2026-03-31)
  - Net worth points: Jan `{assets "12000000", investments "1000000", liabilities "2000000", total "11000000", partial true, unvalued [{name "Gold", reason "NO_PRICE"}]}`; Feb `{"8300000", "12250000", "2000000", "18550000", partial false}`; Mar `{"14380000", "6320000", "2000000", "18700000", partial false}`; `asOf` is `2026-01-31`, `2026-02-28`, `2026-03-31`. February's `assetsDrill` is `{kind:"ASSET", from:"2026-02-01", to:"2026-02-28"}` and its `movementDrill` has no `kind`.
  - Oracle: for each of the three days the point's total equals `netWorth(await sumBalances(userId, day), await loadValuations(userId, day)).total` (the existing code path), and `loadNetWorthReport(userId, {kind:"last12"})`'s last point total equals `(await getDashboard(userId)).netWorth.total` (`"18700000"`) with `asOf` today.
  - Backdated price (EC-25): after `recordPrice` Gold 7,200 on 2026-01-31, the January point becomes valued: investments `"8200000"`, total `"18200000"`, `partial` false. With the range extended to 2026-04-30 the April point is stale (`staleNames ["Gold"]`) with total `"18700000"`.
  - Legacy quantity (EC-23): a lot-mode investment with a live entry that has no lot (a transaction into it created directly through `registry.makeTransaction`) is `unvalued` with reason `NEEDS_QUANTITY` at **every** point, and the totals leave it out as `partial`.
  - No transactions: `empty: true`, `points: []`.
  - Account history, Bank: steps Jan `{0, 15000000, 2650000, 12350000}`, Feb `{12350000, 5080000, 2500000, 14930000}`, Mar `{14930000, 6100000, 2180000, 18850000}`, granularity `"month"`; with range 2026-02-01…2026-03-31 February's opening is `"12350000"`. Card: Jan `{0, 500000, 2000000, -1500000}`, Feb `{-1500000, 0, 250000, -1750000}`, Mar `{-1750000, 0, 0, -1750000}`. Custom 2026-01-01…2026-01-31 gives 31 daily steps and `2026-01-05` is `{opening 10000000, in 5000000, out 0, closing 15000000}`. `nodeId` undefined selects the first non-archived asset (the user's oldest asset node). Salary's id, an expense id, a nonexistent id, and **another user's Bank id** each throw `NotFoundError`.
  - Reconciliation: for each Bank bucket, `loadTransactionScreen(userId, {node: bank.id, from, to})` `netTotal.paise` equals `closing − opening` (`"12350000"`, `"2580000"`, `"3920000"`); closing equals `sumBalances` at the bucket end.
  - Investment growth, portfolio: Jan `{invested "8000000", value "1000000", gain "0", realised "0", covered {1,2}, unvaluedNames ["Gold"]}`; Feb `{"11700000", "12250000", "550000", "0", {2,2}}`; Mar `{"6100000", "6320000", "220000", "480000", {2,2}}`. Gold: Jan `{invested "7000000", value null, gain null}`; Feb `{"10700000", "11250000", "550000"}`; Mar `{"5100000", "5320000", "220000", realised "480000"}`. Fund: `{invested "1000000", value "1000000", gain "0"}` every month. Oracle: Gold's March value equals `(await loadValuations(userId, "2026-03-31")).get(gold.id)` as text. A loss sale world (10 g for 70,000, sold for 62,000 on 2026-03-20) reports `realisedPaise "-800000"` for March. An archived investment is still counted; a non-investment id and a foreign id throw `NotFoundError`.
- [ ] **Step 2: Run to verify failure** — `sh scripts/test-tz.sh tests/server/reports/balance-reports.test.ts`; expected: FAIL.
- [ ] **Step 3: Implement** the three loaders per the rules. Read `readValuationInputs` once per call (or take `options.inputs`) and call `valuationStatesFrom` per bucket end.
- [ ] **Step 4: Run to verify pass**, both passes; `bunx tsc --noEmit && bun run lint`; then `bun run test` to confirm nothing earlier regressed.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(server): net worth, account history and investment growth reports"`

---

### Task 7: Chart components, report shell and navigation

**Files:**
- Create: `src/components/charts/{chart-scale,chart-frame,line-chart,bar-chart,ranked-bars}.ts(x)`, `src/components/charts/chart-scale.test.ts`, `src/lib/report-nav.ts`, `src/lib/report-nav.test.ts`, `src/app/reports/{page,loading}.tsx`, `src/app/reports/{report-shell,report-tabs,range-control,report-notes}.tsx`, `tests/server/charts-render.test.ts`
- Modify: `src/app/app-nav.tsx` (add `"reports"` to `Destination` and a nav item), `src/components/ui/loading-screen.tsx` (add `ReportsSkeleton`), `tests/design/contrast.test.ts`

**Interfaces:**
- Consumes: `RangeChoice`, `rangeParams`, `selectableMonths`, `selectableFinancialYears` (Task 1); `RangeView`, `BucketView` (Task 5); `buttonClass`, `inputClass`, `ChoiceGroup`, `SpotlightCard`, `Collapse`, `formatPaiseText`, `formatDay`.
- Produces:
  ```ts
  // chart-scale.ts (geometry only; Number() of a paise string is allowed here and nowhere is it displayed)
  export function paiseToNumber(text: string): number
  export function niceDomain(min: number, max: number): { min: number; max: number; ticks: number[] } // contains 0, contains min and max, 3–7 evenly spaced ticks on a 1/2/2.5/5 × 10^k step
  export function linePath(points: ({ x: number; y: number } | null)[]): string // a null breaks the line
  // chart-frame.tsx
  export interface ChartTableData { columns: string[]; rows: { label: string; cells: string[] }[] }
  export function ChartFrame(props: { title: string; summary: string; table: ChartTableData; children: React.ReactNode }): JSX.Element // the chart, then <details><summary>View as table</summary><table>…
  // line-chart.tsx
  export interface LineSeries { key: string; label: string; tone: "accent" | "positive" | "negative" | "muted"; values: (string | null)[]; hollow?: boolean[] }
  export function LineChart(props: { title: string; summary: string; labels: string[]; series: LineSeries[]; table: ChartTableData }): JSX.Element
  // bar-chart.tsx
  export function BarChart(props: { title: string; summary: string; labels: string[]; series: { key: string; label: string; tone: "positive" | "negative" | "accent"; values: string[] }[]; table: ChartTableData }): JSX.Element
  // ranked-bars.tsx
  export function RankedBars(props: { rows: { key: string; label: React.ReactNode; amount: string; shareTenths: number | null; muted?: boolean }[] }): JSX.Element
  // report-nav.ts
  export const REPORTS: { slug: "net-worth" | "cash-flow" | "spending" | "income" | "accounts" | "investments"; label: string }[]
  ```
  `REPORTS` labels in order: "Net worth", "Income vs expense", "Spending", "Income", "Account history", "Investment growth". `ReportShell({ current, range, choice, options, rangeError, children })` renders `AppShell current="reports"`, an `h1` "Reports", the tabs (links with `aria-current="page"` on the current one), the range control and `report-notes`. The range control is a client form that pushes `/reports/<slug>?<rangeParams>` (preserving a `node` param), with `last12`, a month picker (`<input type="month">`), a financial-year select, and custom from/to dates; a `rangeError` is shown beside it with `aria-describedby`. `report-notes` renders "History begins {formatDay}." and "{n} future-dated entries are not included." (linking to `/transactions?from=<tomorrow>&to=`), and the empty state "Nothing to report yet" with a "Record a transaction" link to `/transactions`. `/reports` redirects to `/reports/net-worth`. Charts use `useReducedMotion` and no animation when it is on; every mark has an accessible name; a null value is a gap; a negative value draws below the zero line; a `hollow[i]` point is drawn as an outline.

- [ ] **Step 1: Write the failing tests**
  - `chart-scale`: `paiseToNumber("123456789012345678901")` is finite and does not throw; `niceDomain(0, 8_230_000)` has `min 0`, `max 10_000_000`; `niceDomain(-1_500_000, 4_000_000)` contains both values and 0 with evenly spaced ticks; `niceDomain(0, 0)` still returns a positive span; `linePath([{x:0,y:5}, null, {x:10,y:5}, {x:20,y:6}])` is `"M0,5M10,5L20,6"`.
  - `report-nav`: six unique slugs in the order above.
  - `charts-render` (`renderToStaticMarkup` with `createElement`, as `portfolio-render.test.ts` does): `LineChart` with values `["8200000", null, "18700000", "123456789012345678901234"]` renders without throwing, has `role="img"`, a `<table` whose rows carry the labels and the exact text passed in `table`, and two `M` commands for the gap; a `hollow` point renders as an outline (no fill); `BarChart` with a negative value places its bar at or below the zero line; `RankedBars` with `shareTenths: 852` prints `85.2%`, with `null` prints no percentage; none of the outputs contain `NaN` or `undefined`.
  - Contrast: `tests/design/contrast.test.ts` gains non-text pairs (3:1) for `accent`, `positive`, `negative` and `line-strong` on `panel`, in both themes (add only the pairs not already there).
- [ ] **Step 2: Run to verify failure** — `sh scripts/test-tz.sh src/components/charts src/lib/report-nav.test.ts tests/server/charts-render.test.ts tests/design/contrast.test.ts`; expected: FAIL.
- [ ] **Step 3: Implement** the components, shell, tabs, control, notes, redirect page, skeleton and nav entry (pick a `lucide-react` chart icon that exists in the installed version). Read the `dataviz` skill for colour and accessibility rules before writing the SVG; use only the tokens in Global Constraints. The chart's tooltip is a client island and optional; the table is not.
- [ ] **Step 4: Run to verify pass**, both passes; `bunx tsc --noEmit && bun run lint`; start the dev server and confirm `/reports` redirects and the shell renders in both themes (screenshot each).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(ui): chart components, report shell and Reports navigation"`

---

### Task 8: Pages — income vs expense, spending, income

**Files:**
- Create: `src/app/reports/[report]/page.tsx`, `src/app/reports/cash-flow-report.tsx`, `src/app/reports/ranked-report.tsx`, `tests/server/reports-render.test.ts`

**Interfaces:**
- Consumes: Tasks 5 and 7.
- Produces: `[report]/page.tsx`, the dispatcher for all six slugs (an unknown slug or a slug not yet built calls `notFound()`; Task 9 completes it). It reads `searchParams` (first value of a repeated parameter), `parseRangeChoice`, catches `ReportRangeError` to show `rangeError` and fall back to `{kind:"last12"}`, loads the data with `requireUserId()` and `redirectIfUnauthenticated`, and wraps the report in `ReportShell` with the pickers' `options` from `selectableMonths`/`selectableFinancialYears`. `CashFlowReport({ view })` and `RankedReport({ view })` take the Task 5 views.

Behaviour. **Cash flow:** `BarChart` of income and spending per bucket with a table (Period, Income, Spending, Net saved); a partial bucket is labelled with its days ("1–15 Apr"); every figure is a link to `transactionsHref(drill)`; a totals row; when `gainPaise` or `lossPaise` is non-zero a line "Includes ₹X realised gains and ₹Y realised losses from investment sales." **Ranked (spending and income):** `RankedBars` with each name a link to its drill and the amount; a parent row expands (`Collapse`) to "Direct" plus each child, children showing signed amounts and "net refund" when negative; a "Net refunds" block for `refunds`; a `Tag` "from investment sales" on `fromSales` rows and "archived" on archived ones; a total row linking to `totalDrill`. Empty state and notes as in Task 7.

- [ ] **Step 1: Write the failing tests** (render the components with literal views as the server sends them; compare visible text)
  - `CashFlowReport` with the Scenario F views from Task 5: contains `₹1,52,300.00`, `₹51,300.00`, `₹1,01,000.00` (totals), the link `/transactions?flow=spending&from=2026-01-01&to=2026-01-31` and `/transactions?flow=income&from=2026-01-01&to=2026-03-31`, and "Includes ₹2,000.00 realised gains and ₹800.00 realised losses from investment sales."; a partial first bucket shows its day range; `empty: true` shows "Nothing to report yet" and a link to `/transactions`.
  - `RankedReport` EXPENSE view from Task 5: lists Rent before Food before Realised Loss with `85.2%`, `13.3%`, `1.5%`; Food's link is `/transactions?node=<food>%2C<groceries>&from=2026-01-01&to=2026-03-31`; the "Net refunds" block contains Dining `-₹1,500.00` and no percentage; Realised Loss carries "from investment sales"; an all-zero view prints no `NaN`, no percentage and no "undefined".
- [ ] **Step 2: Run to verify failure** — `sh scripts/test-tz.sh tests/server/reports-render.test.ts`; expected: FAIL.
- [ ] **Step 3: Implement** the three files per the behaviour above, in the style of `account-summary.tsx` (SpotlightCard surfaces, `figures` class on money, the `rise` entry animation, tokens only).
- [ ] **Step 4: Run to verify pass**, both passes; `bunx tsc --noEmit && bun run lint`; open `/reports/cash-flow`, `/reports/spending`, `/reports/income` against the seeded test ledger in the browser pane in light and dark, at desktop and 375px width, and fix any layout problem.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(ui): income vs expense, spending and income reports"`

---

### Task 9: Pages — net worth, account history, investment growth

**Files:**
- Create: `src/app/reports/net-worth-report.tsx`, `src/app/reports/account-history-report.tsx`, `src/app/reports/investment-growth-report.tsx`, `src/app/reports/node-picker.tsx`
- Modify: `src/app/reports/[report]/page.tsx`, `tests/server/reports-render.test.ts`

**Interfaces:**
- Consumes: Tasks 6, 7, 8; `PartialNote`, `StaleNote`, `NOT_VALUED_COPY`, `describeBalance`, `formatPaiseText`.
- Produces: the three report components taking the Task 6 views, a client `NodePicker` (a select that pushes the same URL with `node=<id>`), and the dispatcher cases for `net-worth`, `accounts`, `investments`. A `NotFoundError` from a loader (a foreign or wrong-kind `node`) becomes `notFound()`.

Behaviour. **Net worth:** `LineChart` of the totals, partial points hollow; table (Month, Assets, Investments, Owed, Net worth, "Entries") where the component columns link to their drills and each partial row says "Excludes: {names} ({NOT_VALUED_COPY})" and each stale row says the price is old, using `PartialNote`/`StaleNote` wording. **Account history:** picker (archived marked); line of closings; table (Period, Opening, Money in, Money out, Closing) with the period linking to its drill; a liability's balances are shown as an amount owed (`describeBalance`). **Investment growth:** picker ("All investments" first); two lines, Invested and Value, a gap where not valued; table (Month, Invested, Value, Gain, Realised) and, for the portfolio, "covers N of M" on a partial row; stale points marked.

- [ ] **Step 1: Write the failing tests** (render with literal Task 6 views)
  - Net worth: the January point shows `Excludes: Gold` and its total `₹1,10,000.00`; February `₹1,85,500.00`; the chart has one hollow point; the table links include `/transactions?kind=ASSET&from=2026-02-01&to=2026-02-28`; a stale point shows the old-price wording.
  - Account history: Bank's January row shows `₹0.00`, `₹1,50,000.00`, `₹26,500.00`, `₹1,23,500.00`; the Card's closing reads as an amount owed (`₹15,000.00` owed), not a negative balance; a daily view renders 31 rows; the picker lists archived accounts with "archived".
  - Investment growth: the portfolio January row says `covers 1 of 2` and shows Value `₹10,000.00`; Gold's January Value cell reads "Not valued" and the value line has a gap (two `M` commands); March shows Realised `₹4,800.00`; no `NaN` or `undefined` in any output.
  - Dispatcher (server test with a mocked session as `tests/server/dashboard-render.test.ts` does): `/reports/accounts` with another user's node id renders the not-found result and the other user's account name appears nowhere in the HTML; `range=month-2026-13` renders the shell with an error beside the range control and the default range's data; `node` repeated twice uses the first.
- [ ] **Step 2: Run to verify failure** — `sh scripts/test-tz.sh tests/server/reports-render.test.ts`; expected: FAIL.
- [ ] **Step 3: Implement** the three components, the picker and the dispatcher cases.
- [ ] **Step 4: Run to verify pass**, both passes; `bunx tsc --noEmit && bun run lint`; browser-check all three screens in both themes at desktop and 375px against the Scenario N ledger.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(ui): net worth, account history and investment growth reports"`

---

### Task 10: Dashboard

**Files:**
- Create: `src/app/this-month.tsx`, `src/components/charts/sparkline.tsx`
- Modify: `src/lib/dashboard-view.ts`, `src/server/services/balance-service.ts`, `src/app/page.tsx`, `src/app/net-worth-card.tsx`, `tests/server/balance-service.test.ts`, `tests/server/dashboard-render.test.ts`

**Interfaces:**
- Consumes: `loadCashFlow`, `loadNetWorthReport` with `options.inputs` (Tasks 5–6); the `readValuationInputs` result `getDashboard` already reads.
- Produces: `DashboardView` gains
  ```ts
  thisMonth: { monthParam: string; incomePaise: string; spendingPaise: string; savedPaise: string } | null  // monthParam "month-YYYY-MM"; null when isEmpty
  trend: { asOf: CalendarDate; totalPaise: string; partial: boolean }[]  // last 12 month-ends, oldest first, [] when isEmpty
  ```
  `getDashboard` computes both with `Promise.all` alongside its existing reads, passing the already-read valuation inputs so prices and lots are read once. Existing dashboard figures are untouched. `NetWorthCard` wraps its `Sparkline` in a link to `/reports/net-worth` and turns "in accounts", "invested" and "owed" into links to `#summary-ASSET`, `#summary-INVESTMENT` and `#summary-LIABILITY` (the existing `AccountSummary` section ids), keeping the sentence's text unchanged. `ThisMonth` shows three tiles linking to `/reports/income?range=<monthParam>`, `/reports/spending?range=<monthParam>` and `/reports/cash-flow?range=<monthParam>`, and is hidden when `thisMonth` is null.

- [ ] **Step 1: Write the failing tests**
  - `getDashboard` for a user with Salary→Bank 50,000 and Bank→Rent 15,000 dated today: `thisMonth` is `{monthParam: "month-<this year>-<this month>", incomePaise "5000000", spendingPaise "1500000", savedPaise "3500000"}`; `trend` has 12 entries, the last with `asOf` today and `totalPaise` equal to the dashboard's own `netWorth.total`; an empty user gets `thisMonth: null`, `trend: []`. Scenario N's user: the last trend point equals `netWorth.total` `"18700000"`, and `netWorth`, `accounts`, `kindTotals` are identical to the values before this task (compare with the existing assertions, which must still pass).
  - Render: the card contains links with `href="#summary-ASSET"` and `href="/reports/net-worth"`; `ThisMonth` shows `₹50,000.00`, `₹15,000.00`, `₹35,000.00` with the three report links; a partial trend point is marked; no `NaN`.
- [ ] **Step 2: Run to verify failure** — `sh scripts/test-tz.sh tests/server/balance-service.test.ts tests/server/dashboard-render.test.ts`; expected: FAIL.
- [ ] **Step 3: Implement** the additions; the sparkline is a small server-rendered SVG (a `linePath` of the trend, a `role="img"` with a summary label) and shares `chart-scale.ts`.
- [ ] **Step 4: Run to verify pass**, both passes; `bunx tsc --noEmit && bun run lint`; browser-check the dashboard in both themes at desktop and 375px.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(ui): dashboard month strip, net worth trend and drill links"`

---

### Task 11: End to end, isolation, records and ship

**Files:**
- Create: `tests/e2e/reports.spec.ts`, `docs/superpowers/decisions/2026-10-27-m3-rulings.md`
- Modify: `tests/e2e/isolation.spec.ts`, `docs/superpowers/specs/2026-09-11-accufi-design.md` (§8.3 status line; §11 M3 row marked done once merged)

**Interfaces:**
- Consumes: `tests/e2e/seed.ts` helpers (`account`, `incomeSource`, `addExpense`, `investment`, `post` with `{date}`, `buy`, `price`, `nodeId`), `fixtures.ts` (`session`, `pair`), `screens.ts`; the exact leak detector `found()` in the isolation spec.

- [ ] **Step 1: Write the e2e tests** (each test gets its own user; ledgers are seeded with dates in 2026 and the URLs name a custom range so nothing depends on today)
  - *Every report opens*: seed a small Scenario F-like ledger (Salary 50,000 on Jan 5, Bank, Rent 15,000 on Jan 20, Groceries 4,000 on Jan 10); visit the six `/reports/<slug>?range=custom&from=2026-01-01&to=2026-03-31` URLs; each shows its heading and tabs, `aria-current` on the current tab, and its key figure (cash flow `₹50,000.00` income / `₹19,000.00` spending; spending ranked Rent first; income Salary; accounts Bank closing; net worth and investment growth with a Gold holding bought on Jan 10 and priced from Feb 15, January marked not valued).
  - *A figure drills to a list that adds up to it*: click the spending total on cash flow, land on `/transactions` with the filtered total line `Net into these ledgers ₹19,000.00` equal to the figure clicked; on spending click a ledger and the same holds; on income the total line reads `Net out of these ledgers ₹50,000.00`.
  - *Range control*: choose Month → 2026-01 and the URL becomes `range=month-2026-01` with that month's totals; choose Financial year and see April–March; a bad `range=month-2026-13` shows an error beside the control and the default data.
  - *Keyboard and theme*: Tab reaches each report tab, the range control, a drill link and a "View as table" summary (Enter opens it); switching the theme keeps the charts legible (screenshot compared by eye, not asserted); with reduced motion emulated there is no animation class on a chart.
  - *Dashboard*: the "This month" strip shows the month's income and spending and each tile's link opens the matching report; the net worth card's sparkline link opens `/reports/net-worth`.
  - *Isolation* (in `isolation.spec.ts`, using A's Zephyr data and the `pair` fixture): while signed in as B, each of the six report URLs with an explicit custom range contains no secret of A in the rendered text or the HTML, and `/reports/accounts?node=<A's Vault id>` is the not-found page without any secret of A; while signed in as A the same URLs do show A's figures.
- [ ] **Step 2: Run to verify failure** — `bun run test:e2e tests/e2e/reports.spec.ts tests/e2e/isolation.spec.ts`; expected: FAIL only where Task 8–10 behaviour has not been wired (fix the wiring, not the test), PASS elsewhere.
- [ ] **Step 3: Make the e2e suite green** — fix whatever the browser shows; then run the whole suite: `bun run test:e2e` (all earlier specs must still pass).
- [ ] **Step 4: Write the records** — `2026-10-27-m3-rulings.md` lists the design's 12 calls, the three planning amendments (balance-figure proof, `flow` filter, share denominator) and anything parked, each with its cost if wrong, in the style of `2026-10-20-m2-rulings.md`; mark spec §8.3 as built.
- [ ] **Step 5: Full verification** — `bunx tsc --noEmit`, `bun run lint`, `bun run test` (both timezone passes), `bun run test:e2e`; rebuild the Docker app (`docker compose up -d --build`), migrate nothing (M3 has no migration), then walk the six reports and the dashboard against the real account in the browser pane: figures match the dashboard, every drill's total matches, no console errors or failed requests, light and dark, desktop and 375px. Never print the account password.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "test: reports end to end and isolation; M3 rulings"`; then stop and ask the user how to land `feat/m3-reports` (merge locally, push and open a PR, or keep).
