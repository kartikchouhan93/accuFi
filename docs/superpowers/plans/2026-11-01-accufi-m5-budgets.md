# AccuFi M5 — Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user caps a monthly amount on an expense ledger; AccuFi shows, for any month, how much is used, how much is left, where the month will land at this pace, and warns (never blocks) when a budget is near or over, with every figure traceable to its transactions.

**Architecture:** One new table (`Budget`: a cap, a month span, a rollover flag) and nothing else stored. A pure domain module computes months, rollover, status and projection. Spend comes from the existing M3 `findMoves` query, so a budget's "used" is the same arithmetic as the Spending report and the Transactions filtered total. Services create and revise budgets under a ledger row lock; a read service evaluates budgets live, so a backdated expense changes a closed month's verdict immediately.

**Tech Stack:** Bun, Next.js 16 App Router (Server Components, Server Actions), React 19, Prisma 6 / PostgreSQL, Zod 4, Tailwind 4, Vitest, Playwright. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-01-accufi-m5-budgets-design.md` (parent: `2026-09-11-accufi-design.md` §8.5, EC-48 to EC-52).

## Global Constraints

- Money is integer paise (`bigint`, type `Paise`), never `number`; paise **text** across the server/client boundary. Months are `CalendarDate`s of the first day (`YYYY-MM-01`) in `DATE` columns; month arithmetic uses UTC components only. Both timezone passes (`sh scripts/test-tz.sh`) stay green. "Now" is the user's today (`todayFor`), never the server's.
- Layering: `src/domain` is pure (no Prisma, Next or server imports; value imports of other domain/lib code are **relative**). Repositories take `userId` first and put it in every query and join. Services orchestrate. `src/app/**` Server Components pass plain props and never write during render.
- "Used" for a budget on ledger `L` and month `M` = Σ over `L` and, when `L` is a parent, its children (archived included; system ledgers never) of `flowOf("EXPENSE", move)` (money in minus money out) on live transactions dated in `M`, **through today** for the current month. It equals the Transactions screen's `sumNetIntoNodes` for the same ledgers and dates, and the Spending report's row.
- Status: **over** when used > available; **near** when percent ≥ 80 (`NEAR_PERCENT_TENTHS = 800n`) and not over; else **on track**. Percent is tenths of a percent, half-up, bigint, null when available ≤ 0 or used < 0. Projection (current month only): `used × days in month ÷ days elapsed`, half-up in bigint, shown only when at least `PROJECTION_MIN_DAYS = 7` days have elapsed (today's day-of-month counts) and used > 0.
- Rollover: carry into the next month = `max(0, available − used)`, only when both months are budgeted with rollover on and are consecutive (adjacent spans of one ledger chain); otherwise 0. Overspend never lowers the next allowance.
- A budget never blocks, delays or refuses a transaction. A ledger may have several budgets with **non-overlapping** month spans (end month inclusive; only the last may be open-ended). Overlap is refused by the service under a `FOR UPDATE` lock on the ledger row, not by the database.
- Revise defaults to "applies from the current month" (a split: old span ends the month before, new span starts that month, same rollover and end); an earlier-or-equal month corrects the whole span in place.
- Deleting a ledger a budget names is refused with a message, not a foreign-key crash. Hard delete for budgets.
- Tests never depend on the day of the month or the month: fake `Date` with `vi.useFakeTimers({ toFake: ["Date"], now })`, relative dates, and explicit `from`/`to` when looking up entries in the UI.
- Cross-user isolation per repository method (the coverage test in `tests/server/repositories/isolation.test.ts` enumerates repository exports); the isolation e2e covers `/budgets`.
- Lessons already paid for: use `bunx prisma migrate deploy` (not `migrate dev`, which stops at a drift prompt) and remove generated no-op `SET DEFAULT now()` statements from a migration; test pool is capped at 4 connections per worker (vitest) and 10 (e2e); a count read on every signed-in page must be wrapped (try/catch to 0 and `cache()`), as `src/app/pending-count.ts` is; pin every message wording with a test.
- Palette: Graphite & Azure tokens only (no purple, no yellow); status uses the existing accent, notice (orange) and negative tokens. Keyboard reachable, visible focus, reduced motion respected, no horizontal scroll at 375px.
- No new dependency. Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Test commands: a file in both zones `sh scripts/test-tz.sh <path>` (prefix `PATH=$PWD/node_modules/.bin:$PATH` if vitest is not found); everything `bun run test` (tsc plus both passes); `bun run lint`; e2e `bunx playwright test <path>`. A task's last step runs the first and the last two where e2e applies.

## Review Focus

The inputs the spec implies and no obvious test would reach; each has a test in the task named.

1. A month boundary in a user's own timezone (an entry dated 31 Oct versus 1 Nov; a user a day ahead of UTC): the user's date decides the month. (Task 5)
2. Two tabs creating or revising overlapping budgets on one ledger at once: exactly one wins, the other is refused, no overlapping spans ever exist. (Task 4)
3. A ledger archived after it was budgeted, a child archived, a child added later: still evaluated, never double counted within one budget; create refuses an archived ledger, revise allows it. (Tasks 4, 5)
4. The budget warning failing or not applying: a write is never blocked or slowed by it; a refund, an edit that lowers spend and a future-dated entry carry no warning. (Task 6)
5. Eighteen-digit amounts and a February with 29 days: percent, projection and rollover stay exact in bigint. (Task 1)

---

### Task 1: The budget arithmetic (domain)

**Files:**
- Create: `src/domain/budgets.ts`, `src/domain/budgets.test.ts`
- Modify: `src/domain/calendar-date.ts`, `src/domain/calendar-date.test.ts`

**Interfaces:**
- Produces, in `calendar-date.ts`: `monthOf(date: CalendarDate): CalendarDate` (first day of its month), `addMonths(month: CalendarDate, n: number): CalendarDate` (first-of-month in, first-of-month out, `n` may be negative), `daysInMonth(month: CalendarDate): number`.
- Produces, in `budgets.ts` (imports only relative domain modules):
  - `NEAR_PERCENT_TENTHS = 800n`, `PROJECTION_MIN_DAYS = 7`.
  - `interface BudgetSpan { id: string; nodeId: string; amountPaise: Paise; startMonth: CalendarDate; endMonth: CalendarDate | null; rollover: boolean }`.
  - `type BudgetStatus = "ON_TRACK" | "NEAR" | "OVER"`.
  - `spansOverlap(a: Pick<BudgetSpan,"startMonth"|"endMonth">, b: Pick<BudgetSpan,"startMonth"|"endMonth">): boolean` (end inclusive, null = open).
  - `countedNodeIds(nodeId: string, nodes: readonly { id: string; parentId: string | null; kind: LedgerKind; systemRole: SystemNodeRole | null }[]): string[]` — the node first, then its children that are `EXPENSE` and not system, in input order.
  - `percentTenths(used: Paise, available: Paise): bigint | null`; `statusOf(used: Paise, available: Paise): BudgetStatus`.
  - `projectionOf(used: Paise, month: CalendarDate, today: CalendarDate): Paise | null`.
  - `interface MonthFigures { month: CalendarDate; budgetId: string; capPaise: Paise; carryPaise: Paise; availablePaise: Paise; usedPaise: Paise; remainingPaise: Paise; percentTenths: bigint | null; status: BudgetStatus; projectionPaise: Paise | null; overAtPace: boolean }`.
  - `evaluateMonths(spans: readonly BudgetSpan[], usedByMonth: ReadonlyMap<CalendarDate, Paise>, today: CalendarDate): MonthFigures[]` — spans are one ledger's; returns one entry per budgeted month from the earliest start through the current month (each span stops at its end month), ascending, with rollover per the constraints; a month missing from `usedByMonth` has used 0.

- [ ] **Step 1: Write the failing tests.** In `calendar-date.test.ts`: `addMonths("2026-01-01", 1)` is `"2026-02-01"`; `addMonths("2026-11-01", 3)` is `"2027-02-01"`; `addMonths("2026-03-01", -3)` is `"2025-12-01"`; `monthOf("2026-11-17")` is `"2026-11-01"`; `daysInMonth("2028-02-01")` is 29 and `("2027-02-01")` is 28. In `budgets.test.ts` (both zones):
  - `percentTenths(7_990n, 10_000n)` is 799n, `(8_000n, 10_000n)` is 800n; `statusOf` gives ON_TRACK at 7_990, NEAR at 8_000, NEAR at exactly 10_000, OVER at 10_001 (percent still 1000n but status by comparison); `percentTenths` is null for a negative used and for available ≤ 0.
  - `projectionOf(30_000n, "2026-11-01", "2026-11-10")` is 90_000n; `projectionOf(100n, "2026-11-01", "2026-11-07")` is 429n (half-up of 428.57); it is null with 6 days elapsed (`"2026-11-06"`), null when used is 0, null for a past month (`today` in December), and uses 29 days for February 2028.
  - Exactness: with used 999_999_999_999_999_999n and available 1_000_000_000_000_000_000n the percent is exact and no `Number` is involved; the same for a projection.
  - `spansOverlap`: Jan–Mar and Mar–open overlap; Jan–Feb and Mar–open do not; open and open overlap.
  - `countedNodeIds("P", ...)` returns P then its two children (one archived) and skips a non-expense child, a system child and another parent's child.
  - `evaluateMonths` rollover: one span Jan–Mar 2026 cap 10_000n rollover on, used Jan 6_000n, Feb 15_000n, Mar 0 gives Feb carry 4_000n (available 14_000n, OVER by 1_000n), Mar carry 0 (available 10_000n). A gap month between two spans resets the carry. A rollover-off span after a rollover-on span gets carry 0. **Split chain:** span A Jan–Feb cap 10_000n on and span B Mar–open cap 12_000n on, used Jan 4_000n, Feb 0 gives Feb carry 6_000n and Mar available 28_000n. A net-refund month (used −500n) has remaining = available + 500n, ON_TRACK, percent null, and carries `available + 500n`. The current month is the last entry and months after it are not returned; a month absent from `usedByMonth` has used 0.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh src/domain/budgets.test.ts src/domain/calendar-date.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files. Percent and projection use the half-up bigint form `(part × 2k + whole) ÷ (2 × whole)` as `shareTenths` in `reports.ts` does; month arithmetic on `Date.UTC` components only.
- [ ] **Step 4: Run to verify it passes** in both zones (same command).
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(domain): budget arithmetic, rollover chains and projection`.

---

### Task 2: Schema, migration, cleanup

**Files:**
- Modify: `prisma/schema.prisma`; `tests/db/schema.test.ts`; the cleanup order in `tests/server/repositories/fixtures.ts`, `tests/e2e/fixtures.ts` and any other test or script that deletes nodes or users (grep for `recurringRule.deleteMany`)
- Create: `prisma/migrations/20261101000000_budgets/migration.sql`

**Interfaces:**
- Produces: `model Budget { id String @id @default(cuid()); userId; nodeId; amountPaise BigInt; startMonth DateTime @db.Date; endMonth DateTime? @db.Date; rollover Boolean @default(false); createdAt DateTime @default(dbgenerated("now()")) @db.Timestamptz(3); updatedAt DateTime @default(dbgenerated("now()")) @updatedAt @db.Timestamptz(3); @@index([userId, nodeId, startMonth]) }` with relations to `User` and `LedgerNode` (`ON DELETE RESTRICT`), and the back-relations on both. Follow `RecurringRule`'s header-comment style and the `set_updated_at` trigger convention (EC-66) from the recurring migration.
- CHECK constraints in the migration SQL, named `"Budget_<column>_<rule>"`: `amountPaise > 0`; `startMonth` is the first of a month (`EXTRACT(DAY FROM "startMonth") = 1`); `endMonth` null or the first of a month and `>= startMonth`.
- Cleanup: `budget` rows are deleted before `ledgerNode` and `user` wherever those are.

- [ ] **Step 1: Write the failing tests** in `tests/db/schema.test.ts` (follow the recurring constraint tests: `expectCheckViolation` asserts the error text matches a check violation): amount 0 is rejected; a start of `2026-11-15` is rejected; an end before the start is rejected; an end of `2026-12-15` is rejected; the boundary cases (end equal to start, end null) are accepted; the `updatedAt` trigger bumps on UPDATE; a budget naming another user's node is not blocked by the database (ownership is the repository's job, say so in the test name).
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh tests/db`. Expected: FAIL.
- [ ] **Step 3: Edit `schema.prisma`; generate the migration with `bunx prisma migrate dev --create-only --name budgets`, rename the directory to `20261101000000_budgets`, append the CHECKs and the trigger, delete any generated no-op `SET DEFAULT now()` statements for existing tables, then apply with `bunx prisma migrate deploy` and `bunx prisma generate`.** Update the cleanup sites.
- [ ] **Step 4: Run to verify it passes.** `sh scripts/test-tz.sh tests/db`. Expected: PASS.
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(db): budgets, with month and amount constraints`.

---

### Task 3: Repository

**Files:**
- Create: `src/server/repositories/budget-repository.ts`, `tests/server/repositories/budgets.test.ts`
- Modify: `src/server/repositories/errors.ts` (`NotFoundError` entity gains `"budget"`), `tests/server/repositories/fixtures.ts` (`makeBudget`), `tests/server/repositories/isolation.test.ts`

**Interfaces:**
- Consumes: `assertNodesOwned`, `UnitOfWork`/`clientOf`, `toDbDate`/`fromDbDate`, `NotFoundError`.
- Produces (all take `userId` first; `uow?` last where a caller may be inside a transaction):
  - `interface BudgetData { nodeId: string; amountPaise: Paise; startMonth: CalendarDate; endMonth: CalendarDate | null; rollover: boolean }`.
  - `insertBudget(userId, data: BudgetData, uow?): Promise<Budget>` (the node must be the user's, else `NotFoundError("node")`).
  - `findBudgetById(userId, id, uow?): Promise<Budget | null>`; `findBudgets(userId, uow?): Promise<Budget[]>` (ordered by node id, then start month); `findBudgetsForNode(userId, nodeId, uow?): Promise<Budget[]>` (by start month).
  - `updateBudget(userId, id, changes: Partial<Pick<BudgetData, "amountPaise" | "endMonth" | "rollover">>, uow?): Promise<Budget>` — one `updateMany` scoped by user; `NotFoundError("budget")` when it matched nothing.
  - `deleteBudget(userId, id, uow?): Promise<void>` — `NotFoundError("budget")` when none.
  - `lockLedger(userId, nodeId, uow: UnitOfWork): Promise<boolean>` — `SELECT ... FOR UPDATE` on the user's `LedgerNode` row; false when it is not the user's.
  - `countBudgetsNaming(userId, nodeId, uow?): Promise<number>`.

- [ ] **Step 1: Write the failing tests** in `budgets.test.ts` against the real database: insert and read back (paise bigint, months as `CalendarDate`); inserting against another user's node throws `NotFoundError`; `findBudgets` order; `findBudgetsForNode` is per node and ascending by start; `updateBudget` changes only the named fields; updating or deleting a foreign or missing id throws `NotFoundError("budget")`; `countBudgetsNaming` counts; `lockLedger` blocks a second transaction until the first commits (follow the recurring `lockRule` blocking test) and returns false for a foreign node. **Isolation:** every function above with a foreign user's ids behaves as not-found (null, throw, empty list, 0, false), in the exact-leak style of the existing cases; this adds the new module to the coverage test's module list.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh tests/server/repositories/budgets.test.ts tests/server/repositories/isolation.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the repository on the pattern of `recurring-repository.ts` (header comment, `userId` in every `where`, `updateMany` for the conditional update, raw `FOR UPDATE` through `clientOf(uow)`).
- [ ] **Step 4: Run to verify it passes** (same command).
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(budgets): repository with user-scoped queries and a ledger lock`.

---

### Task 4: Create, revise, settings, delete (service and schemas)

**Files:**
- Create: `src/server/services/budget-service.ts`, `src/lib/schemas/budget.ts`, `src/lib/budget-view.ts`, `tests/server/budgets/operations.test.ts`, `tests/server/budgets/schemas.test.ts`

**Interfaces:**
- Consumes: Task 1 (`spansOverlap`, `addMonths`, `monthOf`), Task 3 repository, `requireNode`, `todayFor`, `inTransaction`.
- Produces:
  - `class InvalidBudgetError extends Error { violations: { field: "nodeId" | "amount" | "startMonth" | "endMonth" | "appliesFrom"; message: string }[] }`.
  - `interface BudgetInput { nodeId: string; amount: Paise; startMonth: CalendarDate; endMonth?: CalendarDate | null; rollover: boolean }`.
  - `createBudget(userId, input: BudgetInput): Promise<BudgetSettingsView>`; `reviseBudget(userId, id: string, input: { amount: Paise; appliesFrom: CalendarDate }): Promise<BudgetSettingsView[]>` (one view for a correction, two for a split: the shortened old span, then the new one); `updateBudgetSettings(userId, id: string, input: { endMonth: CalendarDate | null; rollover: boolean }): Promise<BudgetSettingsView>`; `deleteBudget(userId, id: string): Promise<void>`.
  - In `budget-view.ts`: `interface BudgetSettingsView { id: string; nodeId: string; nodeName: string; amountPaise: string; startMonth: string; endMonth: string | null; rollover: boolean }` and `toBudgetSettingsView(budget, nodeName)`. Pure, no server imports.
  - In `schemas/budget.ts` (strict, as `schemas/recurring.ts`): `monthField` (text `YYYY-MM` becomes the `CalendarDate` `YYYY-MM-01`; anything else "Enter a month"); `createBudgetSchema { nodeId, amount (positiveRupees), startMonth, endMonth optional nullable, rollover boolean }`; `reviseBudgetSchema { id, amount, appliesFrom }`; `budgetSettingsSchema { id, endMonth nullable, rollover }`; `budgetIdSchema { id }`.
- Rules (all violations collected into one `InvalidBudgetError`, nothing written on refusal): create refuses a ledger that is not an `EXPENSE`, a system ledger, an archived ledger, a foreign ledger (as `NotFoundError("node")`), an end before the start, and a span overlapping another of the ledger's. Revise: `appliesFrom` after the current month, or after the budget's end, is refused; at or before the start month it corrects the amount in place; otherwise it splits (old `endMonth = addMonths(appliesFrom, -1)`, new row from `appliesFrom` with the same rollover and the old end). Settings: an end before the start is refused; setting or removing an end that would overlap the ledger's next span is refused. Every write runs in `inTransaction`, takes `lockLedger` first and re-reads the ledger's spans after the lock. A second identical create is refused by the overlap rule, which doubles as the double-submit guard (no request key).

- [ ] **Step 1: Write the failing tests** (fake `Date` for today where a month is needed; real database): create stores the span; each refusal names the right field (`nodeId` for non-expense, system, archived; `endMonth`; `startMonth` for an overlap, with the existing span named in the message); a ledger of another user is `NotFoundError`; **review focus 2:** `Promise.all` of two creates for one ledger and overlapping spans leaves exactly one row and one refusal; two revises racing leave no overlapping spans; revise from the current month splits (old ends the month before, new starts now, same rollover, same end); revise from the start month or earlier changes the one row in place; revise from a future month and from after the end are refused; **review focus 3:** an archived ledger still allows revise and settings but refuses create; settings: end month set, removed, refused before start and when it would overlap the next span; delete removes the row and a second delete is not-found; the views carry paise text and month text and no bigint (`JSON.stringify`). `schemas.test.ts`: unknown keys (`userId`, `startMonth` on revise) refused; `2026-11` accepted, `2026-11-15`, `11/2026` and `2026-13` refused; amount parsing (`0`, `-1`, `1,000.50`); non-boolean rollover refused.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh tests/server/budgets`. Expected: FAIL.
- [ ] **Step 3: Implement** the service, schemas and view builder.
- [ ] **Step 4: Run to verify it passes**, both zones.
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(budgets): create, revise, end and delete a budget, overlap-proof`.

---

### Task 5: Evaluating budgets (the read model)

**Files:**
- Create: `src/server/services/budget-report.ts`, `tests/server/budgets/evaluation.test.ts`
- Modify: `src/lib/budget-view.ts` (add the card and screen views), `src/lib/report-drill.ts` only if the drill needs nothing new (it should not)

**Interfaces:**
- Consumes: Task 1, Task 3, `findMoves` (`bucket: "month"`, `kinds: ["EXPENSE"]`, `nodeIds`), `flowOf`, `listAllNodes`, `todayFor`, `transactionsHref`, `toPickerNode`.
- Produces:
  - Views in `budget-view.ts`: `interface BudgetHistoryRow { month: string; usedPaise: string; availablePaise: string; status: BudgetStatus; drillHref: string }`; `interface BudgetCard { budgetId: string; nodeId: string; name: string; archived: boolean; countedNames: string[]; amountPaise: string; carryPaise: string; availablePaise: string; usedPaise: string; remainingPaise: string; percentTenths: string | null; status: BudgetStatus; projectionPaise: string | null; overAtPace: boolean; rollover: boolean; startMonth: string; endMonth: string | null; drillHref: string; history: BudgetHistoryRow[] }`; `interface BudgetsScreen { today: string; month: string; months: string[]; cards: BudgetCard[]; empty: boolean }`.
  - `loadBudgetsScreen(userId: string, month?: CalendarDate): Promise<BudgetsScreen>` — `month` defaults to the current month; a month outside the selectable range is clamped to it (never an error); `months` is every month from the earliest start to the current one; `cards` holds one per ledger whose budget covers the month, ordered most strained first (OVER, then NEAR, then by percent descending, then name); `history` is that ledger's every budgeted month through the current one, newest first. One `findMoves` call serves all budgeted ledgers and their children.
  - `loadBudgetAttention(userId: string): Promise<{ near: number; over: number }>` — counts for the current month, over the same evaluation.
  - `drillHref` = `transactionsHref({ node: countedIds, flow: "spending", from: month start, to: min(month end, today) })`.

- [ ] **Step 1: Write the failing tests** (fake `Date`; real database; entries made through the repository fixtures):
  - **Reconciliation:** for a ledger with spend in the month, `usedPaise` equals `sumNetIntoNodes(userId, { nodeIds: counted, from, to })` and equals the Spending report's row from `loadRanked` for the same range; a parent budget equals own plus children; the child's own budget shows only the child's spend; the same child spend appears in both cards and is never counted twice within the parent's.
  - **Exit criterion:** a closed month under budget (card for that month ON_TRACK); record an expense dated inside it; `loadBudgetsScreen` for that month now reports OVER by exactly that amount and the history row agrees; soft-delete the expense and it is ON_TRACK again.
  - Current month counts through today only (a future-dated entry is excluded); a refund lowers used in the month it happened (EC-52); a net-refund month shows negative used; EC-48 spend before the budget was created in the same month counts; spend before `startMonth` appears in no card and no history.
  - **Review focus 1:** two users in `Pacific/Kiritimati` and `Pacific/Pago_Pago` with an entry dated 31 Oct and one dated 1 Nov: each user's own today decides the current month and the entries land in the right months; selectable `months` are correct at 1 Jan and 31 Dec.
  - **Review focus 3:** an archived ledger's budget is still a card with `archived` true; an archived child still counts toward its parent; a child added after the budget was created counts from its own entries on; system ledgers (Opening Balance Contra, Realised Loss) are never counted.
  - Rollover chain across two spans appears in `carryPaise` and `availablePaise`; projection appears only for the current month after 7 days; ordering of cards; an out-of-range `month` is clamped; `empty` is true with no budgets; another user's budgets never appear; `JSON.stringify` of the screen has no bigint.
  - `loadBudgetAttention` counts NEAR and OVER for the current month only.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh tests/server/budgets/evaluation.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `budget-report.ts`: read budgets and the user's expense ledgers, build counted ids with `countedNodeIds`, one `findMoves` over the earliest start through today, sum `flowOf("EXPENSE", move)` per counted id per month into `usedByMonth` per budgeted ledger, call `evaluateMonths`, build the views with paise text and month text.
- [ ] **Step 4: Run to verify it passes**, both zones.
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(budgets): live evaluation, reconciled with the transactions screen`.

---

### Task 6: Where it warns and where it refuses (integration)

**Files:**
- Create: `src/app/budget-attention.ts`, `src/app/budget-notice.tsx`, `tests/server/budgets/warnings.test.ts`, `tests/server/budgets/node-delete.test.ts`
- Modify: `src/lib/transaction-view.ts` (`Warning.code` gains `"BUDGET_OVER" | "BUDGET_NEAR"`), `src/server/services/transaction-service.ts` (`warningsFor`), `src/server/services/budget-report.ts` (add `budgetWarningsFor`), `src/server/services/node-service.ts` (`removeLedgerNode`), `src/app/nodes/actions.ts`, `src/app/page.tsx`

**Interfaces:**
- Consumes: Task 5 evaluation, `countBudgetsNaming`.
- Produces:
  - `budgetWarningsFor(userId: string, row: Transaction, today: CalendarDate): Promise<Warning[]>` in `budget-report.ts`: for an entry whose destination ledger is counted by a budget that covers the entry's month, judged against the month's used amount **after** the write and **before** it (after minus this entry's contribution): `BUDGET_OVER` when the budget ends over ("`<ledger>` is over budget by `<₹X>` this month.", naming the budgeted ledger, once per over budget), `BUDGET_NEAR` only when this entry crossed from on track to near ("`<ledger>` is at `<n>%` of its budget this month."). No warning for an entry that lowers or does not change spend, for a future-dated entry (after today), or when nothing is budgeted. Any failure inside it is caught, logged with the `[budgets]` prefix and answers `[]`.
  - `warningsFor` appends the budget warnings after the existing ones (existing order `OVERDRAWN`, `OVER_CREDIT_LIMIT`, `FUTURE_DATED` unchanged, then `BUDGET_OVER`, `BUDGET_NEAR`).
  - `class NodeInBudgetError extends Error` in `node-service.ts`; `removeLedgerNode` refuses, after the transactions and recurring checks, with it when `countBudgetsNaming > 0`; message exactly: `A budget uses this ledger. Delete the budget, or archive the ledger instead.` mapped by `src/app/nodes/actions.ts` through the existing `invalid` path, as `NodeInRecurringRuleError` is.
  - `budgetAttention = cache(async (userId) => number)` in `src/app/budget-attention.ts`: near plus over from `loadBudgetAttention`, wrapped like `pendingCount` (try/catch to 0, logged `[budgets]`). `BudgetNotice({ count })` renders one line, "1 budget needs attention" / "N budgets need attention", linking to `/budgets`, only for a count above zero; `src/app/page.tsx` renders it beside the existing pending notice.

- [ ] **Step 1: Write the failing tests.** `warnings.test.ts` (real database, fake `Date`): an expense that takes a budget from 70% to 85% carries `BUDGET_NEAR` with the percent, and one from 85% to 105% carries `BUDGET_OVER` with the exact over-by amount; a second entry while already over still carries `BUDGET_OVER`; an entry below 80% carries none; a refund, an edit that lowers the amount and an entry dated after today carry none; a backdated entry is judged against **its own month**; a child entry warns for both the child's budget and its parent's (two warnings, each naming its own ledger); an unbudgeted ledger carries none; **review focus 4:** with `findMoves` stubbed to throw, the transaction is still recorded, `warnings` has no budget entry and the failure is logged with the `[budgets]` prefix (assert the prefix); the order of warnings is pinned. `node-delete.test.ts`: deleting a ledger with a budget (and no transactions) is refused with the exact message through the service and returns `{ ok: false }` with that message through the node action, the budget row remains; a ledger with no budget still deletes; another user's budget on a same-named ledger does not block; archiving a budgeted ledger still works. Render tests: `BudgetNotice` text for 1 and 3, nothing for 0; `budgetAttention` returns 0 and logs when the read throws, and is one read per request where testable (as `tests/server/pending-count.test.ts` does).
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh tests/server/budgets/warnings.test.ts tests/server/budgets/node-delete.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the pieces above. The warning's "before" state is the month's used amount less this entry's own contribution (an entry into a counted ledger adds its amount).
- [ ] **Step 4: Run to verify it passes**, both zones; existing transaction-service and node-action tests stay green (update only assertions that pin the exact warning list or code union, and say so).
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(budgets): non-blocking warnings, a refusing ledger delete, a dashboard notice`.

---

### Task 7: Server Actions and loaders

**Files:**
- Create: `src/app/budgets/actions.ts`, `src/app/budgets/budget-failure.ts`, `tests/server/budgets/actions.test.ts`
- Modify: `src/server/action-support.ts` (`wrote()` also revalidates `/budgets`), the tests that pin the exact `wrote()` list (node, transaction, investment and recurring action tests), `src/server/services/budget-service.ts` (loaders)

**Interfaces:**
- Consumes: Task 4 service and schemas, Task 5 `loadBudgetsScreen`, `parseInput`, `failed`, `ok`, `redirectIfUnauthenticated`, `wrote` from `action-support`.
- Produces:
  - `loadBudgetForm(userId: string, budgetId?: string): Promise<{ nodes: PickerNode[]; budget: BudgetSettingsView | null; today: CalendarDate }>` — `nodes` are the user's live, non-system `EXPENSE` ledgers; for an existing budget its ledger is included even when archived; `NotFoundError("budget")` for a foreign or missing id.
  - Actions, each calling `requireUserId()` first, parsing `unknown` with its schema, returning `ActionResult`, calling `wrote()` after a write: `createBudgetAction`, `reviseBudgetAction`, `updateBudgetSettingsAction`, `deleteBudgetAction`.
  - Failure mapping in `budget-failure.ts`: `InvalidBudgetError` to `invalid` with field errors under its field names; `NotFoundError` to `not_found` with exactly `This budget no longer exists. It may have been deleted in another tab.` (a node not-found says `That ledger was not found`); anything else is rethrown.

- [ ] **Step 1: Write the failing tests** in `actions.test.ts`, shaped like `tests/server/recurring/actions.test.ts`: a lapsed session redirects to `/login` for every exported action (pass `undefined` input so a parse before the session check would fail); bad input returns `invalid_input` with field errors and writes nothing; each action's result is plain data (`JSON.stringify` on success **and** failure paths, no bigint or Date); an overlap comes back as `invalid` under `startMonth`; a foreign budget id is `not_found` with the exact message and changes nothing; `wrote()` revalidated `/budgets`; `loadBudgetForm` lists only live non-system expense ledgers, includes an archived ledger for its own budget, and refuses a foreign budget id.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh tests/server/budgets/actions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the actions, mapping and loader; update the pinned `wrote()` assertions to include `/budgets`.
- [ ] **Step 4: Run to verify it passes**, both zones.
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(budgets): Server Actions and form loader`.

---

### Task 8: The Budgets screen

**Files:**
- Create: `src/app/budgets/page.tsx`, `loading.tsx`, `month-picker.tsx`, `budget-card.tsx`, `history-table.tsx`, `tests/server/budgets-render.test.ts`
- Modify: `src/app/app-nav.tsx` (a `"budgets"` destination with the lucide `PiggyBank` icon, between Recurring and Reports)

**Interfaces:**
- Consumes: Task 5 `BudgetsScreen`/`BudgetCard`, Task 7 actions, existing `Amount`, `SpotlightCard`, `Collapse`, `buttonClass`, the notice/feedback pattern from `src/app/recurring/`.
- Produces: `/budgets?month=YYYY-MM`. The page reads only (`loadBudgetsScreen`, an unreadable or out-of-range `month` falls back to the current month), wrapped in `AppShell current="budgets"` with the `redirectIfUnauthenticated` pattern. The month picker: previous and next links plus a select (links, so it works without scripting), bounded by `months`. A card per budget: ledger name with "includes N sub-ledgers" naming them and "archived" when so; cap and, when rollover is on and carry is above zero, "+ carried over"; used; remaining (or "over by"); a progress bar clamped visually at 100% while the figures stay honest (a net refund shows negative used and an empty bar); a status chip (on track, near, over, each with text, never colour alone); the projection line for the current month ("At this pace: ₹X by month end", "over at this pace" when so); the used amount as a drill link; links to edit and a delete behind a confirm; a "Past months" disclosure with `HistoryTable` (month, used, available, status, drill link per row; over months marked in text). Empty state says what a budget is for and links to New budget. Names of buttons and links carry the ledger name as an sr-only suffix ("Edit Groceries budget") as the Recurring screen does.

- [ ] **Step 1: Write the failing render tests** (server-render the components as `recurring-render.test.ts` does): a card for each status shows its chip text; an over card says "over by" with the amount and a net-refund card shows negative used without an "over"; the projection line appears only when `projectionPaise` is set and says "over at this pace" when `overAtPace`; the bar width clamps at 100% for 250% used; the parent card names its sub-ledgers; an archived ledger is marked; the drill link equals the card's `drillHref`; the history table lists every month with its status text and a link; the month picker links for the first month have no "previous" and for the current month no "next"; the empty state links to `/budgets/new`; all amounts go through `Amount` from paise text (an eighteen-digit amount renders exactly); the nav item for `budgets` exists with its accessible name; no raw colours or purple/yellow classes in the new files.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh tests/server/budgets-render.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the page and components in the look of the Recurring and Investments screens (read `src/app/recurring/` and `src/app/investments/`; follow `/Users/kartikchouhan/.claude/projects/-Users-kartikchouhan-Documents-AccuFi/memory/ui-design-preferences.md`: Graphite & Azure, both themes, tasteful Aceternity-style effects where existing screens use them). `New budget` and `Edit` are plain links to the Task 9 pages, which 404 until then.
- [ ] **Step 4: Run to verify it passes**, both zones. Then look at `/budgets` in the browser against a throwaway account on the **test database** (as in the M4 visual checks: `next dev` on port 3302, `RECURRING_SWEEP=off`, one-off script for the account and a few budgets and entries), in light and dark at desktop and 375px; check no horizontal scroll and visible focus; delete the throwaway user; never touch the dev database or port 3100.
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(budgets): the budgets screen with status, projection and history`.

---

### Task 9: The budget form

**Files:**
- Create: `src/app/budgets/new/page.tsx`, `src/app/budgets/[id]/edit/page.tsx`, `src/app/budgets/budget-form.tsx`, `src/app/budgets/budget-fields.ts`, `src/app/budgets/budget-fields.test.ts`, `tests/server/budgets-form-render.test.ts`

**Interfaces:**
- Consumes: Task 7 actions and `loadBudgetForm`, Task 1 `addMonths`/`monthOf`, `NodePicker`/`Field` patterns from the rule form, `newRequestKey` is **not** used (overlap refusal guards double submit).
- Produces: one client form. **New:** ledger (live non-system expense ledgers only), amount (rupee text), start month (default the current month), optional end month, rollover switch with a one-line explanation ("Unspent budget carries into the next month"). **Edit:** two sections: *Amount* (amount plus "Applies from", default the current month, with a live sentence from `describeRevision`) and *Settings* (end month, rollover). Pure helpers in `budget-fields.ts`: `describeRevision(startMonth: string, appliesFrom: string, endMonth: string | null): string` — in words what saving will do: "Raises it from `<month>`; earlier months keep the old amount." (a split), "Corrects the amount for every month of this budget." (at or before the start month), and the refusal wording for a month beyond the end; `monthOptions(from: string, to: string): { value: string; label: string }[]`; `monthText(month: string): string` (e.g. "November 2026"). The form shows server field errors beside their fields, focuses the first invalid field, disables the button while submitting with an in-flight guard, and on success goes to `/budgets?month=<the budget's start month, or the current month>` and announces. Not found pages use `notFound()`; a foreign id is a plain 404.

- [ ] **Step 1: Write the failing tests.** `budget-fields.test.ts`: `describeRevision` for each of its three cases with exact strings; `monthOptions("2026-09", "2026-11")` gives three labelled options in order; `monthText("2026-11")` is `"November 2026"`. `budgets-form-render.test.ts`: the new form lists only expense ledgers (pass a mixed `nodes` list), defaults the start month to the current month, shows the rollover explanation; the edit form shows both sections, the "Applies from" default is the current month and the sentence beside it matches `describeRevision`; an archived ledger appears in the edit form for its own budget; the pages call `notFound()` for a foreign or missing id (real database rows, as the recurring form render tests do); no server imports in the client component.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh src/app/budgets tests/server/budgets-form-render.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, form and pages. Keep the form split (helpers pure and tested; the component mostly markup); reuse exported `Field` and the ledger picker pattern rather than copying.
- [ ] **Step 4: Run to verify it passes**, both zones. Then create, revise from this month, end and delete a budget by hand in the browser (same throwaway-account method as Task 8, light and dark, 375px) and clean up.
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(budgets): create and revise a budget, in words`.

---

### Task 10: End to end, isolation, documentation

**Files:**
- Create: `tests/e2e/budgets.spec.ts`
- Modify: `tests/e2e/seed.ts` (`budget(userId, opts)`, a thin wrapper over `createBudget` taking ledger **names**), `tests/e2e/isolation.spec.ts`, `README.md` (a "Budgets" section), `docs/superpowers/specs/2026-11-01-accufi-m5-budgets-design.md` (status line: approved, built), `docs/superpowers/specs/2026-09-11-accufi-design.md` (§8.5 status line like §8.3's), `docs/superpowers/decisions/2026-11-01-m5-rulings.md` (create: every "Ruling:" line from the controller's ledger as a numbered ruling, every deferred minor under "Known and parked" grouped by area, and "What M5 does not do" from the design's non-goals)

**Interfaces:** consumes everything above.

- [ ] **Step 1: Write the e2e specs** (each test its own user; dates relative to the user's today with the `today` helper; entries looked up with explicit `from`/`to`; locators scoped to the visible `main` and to the card's own container; names with the sr-only suffix matched by role name):
  - **Exit criterion:** a budget from two months ago on a ledger with an expense in last month under the cap: last month's history row says on track; post an expense dated inside last month that crosses the cap (through the transaction form, with the date chosen); the history row and the month's card now say over by exactly the crossing amount and the drill link's filtered total equals "used"; delete that expense and it is on track again.
  - Create from the form (rupees typed, start month default), see the card with 0% used; record an expense through the transaction form and see used, remaining and the status move; the transaction form shows the budget warning notice when the entry crosses the cap and the entry is recorded regardless.
  - Parent roll-up: a parent budget with a child entry counts it; the child's own budget shows it too.
  - Rollover: a rollover budget with unspent last month shows "carried over" and the larger available amount this month.
  - Revise from this month: the card's cap changes now and last month's history row keeps the old cap; revise from the start month corrects every month.
  - Deleting a budgeted ledger on the Ledger screen shows the refusal message and the ledger remains; deleting the budget then lets it go.
  - The dashboard line "N budget(s) need(s) attention" appears only when one is near or over, and links to `/budgets`.
  - Keyboard operation of the month picker, a card's actions and the form; dark theme and reduced motion render the screen.
  - **Isolation** (Zephyr pattern): A's budget ledger name and amount never appear in B's `/budgets`, B's dashboard or B's page HTML (use the exact leak detector); B visiting `/budgets/<A id>/edit` gets not-found identical to a ghost id; B's revise, settings and delete actions on A's id return not-found and A's rows are unchanged.
- [ ] **Step 2: Run to verify they fail.** `bunx playwright test tests/e2e/budgets.spec.ts tests/e2e/isolation.spec.ts`. Expected: FAIL (before the seed helper exists, then on any gap found).
- [ ] **Step 3: Add the seed helper, fix any defect the specs expose** (each fix gets a regression test at the lowest layer that shows it, and is reported), write the README section (what a budget is, that it warns and never blocks, that nothing is frozen, rollover in one sentence) and the status lines, and create the rulings file.
- [ ] **Step 4: Run the whole gate:** `bun run test`, `bun run lint`, then the **full** `bunx playwright test` (the known flake `tests/e2e/transactions.spec.ts` around line 818 may fail under parallel load and passes alone; if exactly that fails, re-run it alone and say so). Expected: all green; report the counts.
- [ ] **Step 5: Commit** `test(budgets): end-to-end and isolation proof, docs`.
