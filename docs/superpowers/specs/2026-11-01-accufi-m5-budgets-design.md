# AccuFi M5 — Budgets: design

**Status:** Approved, built on branch `feat/m5-budgets`; amended in execution (the warning is judged on the state after the write only, not on a crossing, and the revision sentence is neutral rather than "Raises it"; both recorded in `docs/superpowers/decisions/2026-11-01-m5-rulings.md`). **Date:** 2026-11-01. **Builds on:** `2026-09-11-accufi-design.md` §8.5 (budgets), §6.4, EC-9, EC-48 to EC-52, and on the M3 report arithmetic (`flowOf`, `rankFlows`, `findMoves`, `transactionsHref`). M0–M4 are merged and pushed.

The user asked for the design to be drafted straight from the spec, without a question round. Everything the spec leaves open is decided here and listed in **Calls I made** at the end, each with what it costs if wrong.

## 1. Intent

AccuFi already shows where money went (the Spending report). A budget turns that into a promise made in advance: "groceries: ₹12,000 a month". M5 answers three questions for each budgeted ledger and each month: **how much of it is used, how much is left, and where will I land at this pace.** It warns when a budget is near or over. It never blocks anything.

The organising rule is the one the spec states in EC-49: **nothing is frozen.** A budget's numbers are never stored; they are computed from the transactions every time, so a backdated expense that pushes a closed month over its cap changes that month's status the moment it is recorded. That is the milestone's exit criterion: **backdated spend correctly reopens a closed period's overspend.**

The second rule is the one M3 made the whole of its design: **a figure must trace to entries.** A budget's "used" amount is exactly the sum the Transactions screen shows for the same ledgers and month, and it links there.

## 2. Goals, non-goals, anti-goals

**Goals**
- A `Budget` is a monthly cap on one `EXPENSE` ledger: amount, start month, optional end month, rollover flag (default off).
- A budgets screen, for a chosen month, with per-budget consumed, remaining, a progress bar, a projection at the current pace, and a status of **on track**, **near** or **over**.
- Parent ledgers roll their children up (EC-51); a child may carry its own budget and both are evaluated.
- Refunds into a budgeted ledger reduce that month's consumption, in the month the refund happened (EC-52).
- Rollover (EC-50): opt-in, unspent budget accumulates across consecutive months.
- A history of past months per budget, so a retrospective overspend is visible and checkable (EC-49).
- A warning where it is useful and cheap: on the budgets screen, as a one-line notice on the dashboard, and as a non-blocking warning when recording an expense that takes a budget over.
- Every figure drills to its transactions.

**Non-goals (M5)**
- Income budgets, budgets on assets, liabilities or investments, per-tag budgets, yearly or weekly budgets, zero-based planning.
- Notifications of any kind (email, push). The screens are the notification.
- Prorating a budget created mid-month (EC-48: the spec says it confuses more than it helps).
- Forecasts beyond the single at-this-pace projection. Charts beyond a progress bar (the history is a table).
- Changing the Spending report, or putting budget markers on it.
- Applying budgets to pending recurring occurrences (they are not spend until posted).

**Anti-goals (a failure even if every test passes)**
- A "used" figure that differs by a paisa from the Transactions screen's filtered total for the same ledgers and month, or from the Spending report's row for the same ledger and range.
- Anything that blocks, delays or refuses a transaction because of a budget.
- A past month's status that does not change when a backdated entry lands in it.
- A parent budget that counts a child twice, or a child's spend missing from its parent.
- Future-dated entries counted before their day, or the opening-balance and realised-loss system ledgers counted at all.
- Changing a budget's amount silently rewriting the verdict on months already closed.

## 3. Constraints

- Layering unchanged (§9.2): `src/domain/budgets.ts` is pure (no Prisma, Next or server imports; value imports of other domain/lib code are relative). A new `budget-repository.ts` takes `userId` first and scopes every query and join. `budget-service.ts` orchestrates. `src/lib/schemas/budget.ts` holds the form schemas; `src/lib/budget-view.ts` holds the plain-data views. `src/app/budgets/**` are Server Components passing plain props (paise as text, days as `CalendarDate`).
- Money is integer paise (`bigint`), never `number`; paise text across the server/client boundary. Months are `CalendarDate`s of the first day (`YYYY-MM-01`) in a `DATE` column; arithmetic uses UTC components only. Both timezone passes (`scripts/test-tz.sh`) stay green. "Now" is the user's today (`todayFor`).
- Spend is computed in SQL through the existing `findMoves` (one query for all budgeted ledgers and their children, bucketed by month), never by loading every transaction. Soft-deleted transactions never count; archived ledgers always do.
- Reports and budgets agree: consumption is `flowOf("EXPENSE", move)` (money in minus money out), summed over the ledger and its children, over the month, through today.
- Cross-user isolation tested per repository method with a foreign user's ids; the isolation e2e is extended to `/budgets`.
- A budget names a ledger, so deleting a ledger a budget names must refuse with a message, not crash on the foreign key (the M4 lesson).
- Tests must not depend on the day of the month or the month: use dates relative to a faked clock, and explicit `from`/`to` when looking things up in the UI (the other M4 lesson).
- No new dependency. Palette: Graphite & Azure tokens only (no purple, no yellow); status uses the existing accent, notice (orange) and negative tokens. Keyboard reachable, visible focus, reduced motion respected.

## 4. Meaning of the figures

For a budget on ledger `L`, month `M` (a calendar month in the user's timezone):

| Figure | Definition |
|---|---|
| Ledgers counted | `L` itself, and, when `L` is a parent, its children (archived included). System ledgers are never budgetable and never counted. |
| Used (consumed) | Σ over the counted ledgers of (money into the ledger − money out of it, i.e. refunds) on live transactions dated in `M`, through today for the current month. Can be negative for a month: shown as is, labelled "net refund". |
| Cap | The budget's amount for `M`. |
| Carry (rollover) | See below. Zero when rollover is off. |
| Available | Cap + carry. |
| Remaining | Available − used. Negative means over. |
| Percent used | used ÷ available, in tenths of a percent, half-up, bigint. Null when available is zero or negative. |
| Status | **over** when used > available; **near** when percent ≥ 80 and not over; otherwise **on track**. |
| Projection | Current month only: `used × days in month ÷ days elapsed`, half-up in bigint, shown only when at least 7 days have elapsed and used > 0. "Over at this pace" when it exceeds available. |

**Rollover.** Walk the ledger's budget months in order. Carry into the first month is 0. Carry into the next month is `max(0, available − used)` of the month before, **only** when both months are budgeted with rollover on and consecutive. A month with no budget, or with rollover off, resets the carry to 0. Overspend does not reduce next month's allowance (a budget warns; it does not borrow).

**Budget spans.** A ledger may have several budgets with non-overlapping month spans (start month, optional end month inclusive; only the last may be open-ended). This is how an amount changes over time: the old span ends the month before and a new one begins. Rollover chains run across adjacent spans.

**Months shown.** From the earliest start month of the user's budgets to the current month. A budget has no status before its start month or after its end month. Months after the current month are not shown.

## 5. Data model

One migration, with CHECK constraints in its SQL (as the lot and recurring migrations did).

```
model Budget {
  id, userId, nodeId        // an EXPENSE ledger the user owns, not a system ledger
  amountPaise BigInt        // > 0 (CHECK)
  startMonth  DATE          // first day of a month (CHECK)
  endMonth    DATE?         // first day of the last month it applies to (CHECK: first of month, >= startMonth)
  rollover    Boolean @default(false)
  createdAt, updatedAt
  @@index([userId, nodeId, startMonth])
}
```

Nothing else is stored: no used amount, no status, no carry. `LedgerNode` and `User` gain back-relations; the foreign key to `LedgerNode` is `ON DELETE RESTRICT` like the others. No overlap constraint in the database (it would need an extension): the service refuses an overlapping span inside a transaction that locks the ledger row (`FOR UPDATE`, as `lockRule` does), so two tabs cannot both create one.

## 6. Operations

- **Create:** ledger, amount (rupee text), start month (default the current month), optional end month, rollover. Refuses: a non-expense ledger, a system ledger, an archived ledger, a foreign ledger, an overlapping span for that ledger, an end before the start, amount ≤ 0.
- **Revise:** amount plus an **applies from** month, defaulting to the **current month** so the default is never a silent rewrite of history. If the month is the budget's start month or earlier, the amount is corrected for the whole span in place. If it is later, the budget is **split**: the old span ends the month before and a new span starts that month with the new amount, same rollover and end. Refuses a month after the end or in the future beyond the current month.
- **Set end month / toggle rollover:** in place. Both are recomputed over history like everything else.
- **Delete:** removes the budget row. Nothing else depends on it.
- **Ledger delete:** `removeLedgerNode` refuses with a clear message when any budget names the ledger, and says to delete the budget or archive the ledger. (Archiving is allowed: an archived ledger keeps its budget, flagged "archived".)

## 7. Where it warns

- **The budgets screen:** status chips, the over-by amount, the projection line.
- **The dashboard:** one line, only when at least one budget is near or over this month ("2 budgets need attention", linking to `/budgets`), and nothing else about the dashboard changes.
- **Recording an expense:** the transaction view's existing `warnings` channel gains a budget warning when the entry's month, for a budget covering its destination ledger, is now over (or newly near): "This puts Groceries over budget by ₹1,250 this month." It is only a message; the entry is recorded either way. It covers a backdated entry for its own month.

## 8. Screens

- **Budgets** (`/budgets`, a new nav destination). A month picker (previous/next and a select; the current month by default). Per budget a card: ledger name (and "includes N sub-ledgers" with their names), cap and carry, used, remaining, a progress bar that clamps visually at 100% while the figures stay honest, the status chip, the projection line for the current month, and links: the used amount drills to `/transactions` with the ledgers, `flow=spending` and the month's dates; Revise, End, Delete. A "Past months" disclosure per budget is a table of month, used, available, status (over months marked), each with its drill link. An empty state says what a budget is for and offers New budget.
- **New / revise budget:** a form on the pattern of the transaction and rule forms (ledger picker limited to the user's live, non-system expense ledgers; rupee text; month selects; the rollover switch with a one-line explanation of EC-50). Revise shows "Applies from" and says in words what will happen ("raises it from June; earlier months keep the old amount").
- Keyboard reachable, visible focus, no horizontal scroll at 375px, light and dark through the existing tokens, reduced motion respected.

## 9. Testing

- **Domain** (both timezone passes): months between start and end; status at 79.9, 80, 100 and 100.1 percent (tenths, half-up); projection rounding and the 7-day gate; leap-year February; rollover chains including a split, a gap month, rollover off in the middle and an overspent month (carry 0, not negative); a negative (net-refund) month; parent roll-up with refunds on a child; a child with its own budget counted in both budgets and never twice in one.
- **Reconciliation** (real database): for a seeded ledger, used equals the Transactions screen's filtered total (`sumNetIntoNodes`) for the same ledgers and month, and equals the Spending report's row for the same range; the current month counts through today only.
- **Exit criterion, honesty:** a closed month under budget; record an expense dated in it; the month is now over, by exactly that amount, and the budgets screen, the history table and the drill all agree. Delete that expense: it is under again.
- **Operations:** overlapping span refused (and under two concurrent creates); revise splits at the right month and leaves earlier months' figures unchanged; correction in place changes the whole span; a ledger delete refused with the message (live budget and none); archiving keeps the budget evaluated.
- **Warning on record:** an expense that crosses the cap carries the warning and is recorded; one that does not carries none; a backdated entry is judged against its own month.
- **Isolation:** every repository method with a foreign user's ids; the isolation e2e covers `/budgets` and a foreign budget id.
- **e2e:** create, see the figures, record an expense and watch the status change, revise from the current month, the history table, the drill matching, the dashboard line, keyboard and dark theme. Assertions use explicit date ranges and relative dates, never "this month".

## 10. What is left to the builder

The SQL shape of the one spend query (one `findMoves` call for all budgeted ledgers and their children is expected, not prescribed); progress-bar and card visuals within the palette rule; copy for empty, near, over and net-refund states; whether the month picker is links or a client control; exactly how the budget warning is carried through `warnings` (a new warning code is expected).

## 11. Calls I made (change any)

| # | Call | Costs if wrong |
|---|---|---|
| 1 | Budgets are **calendar months in the user's timezone**, not financial-year months. | The financial year only groups months, so none; a FY view would be a screen change. |
| 2 | **Several non-overlapping spans per ledger**, with amount changes made by split. | A single row with an amount history table; a different model, moderate. |
| 3 | **Revise defaults to "from the current month"**, so history is never silently rewritten; correction in place is the explicit earlier-month choice. | A simpler "edit amount" would rewrite closed months, which the spec's no-freezing rule makes surprising. |
| 4 | **Rollover carries unspent only, never negative**, and chains across adjacent spans. | Negative carry is a one-line change in the domain function. |
| 5 | **"Near" is 80%**, a constant. | One constant. |
| 6 | **Projection needs 7 elapsed days and some spend**, linear by days. | One constant; earlier is noisier (rent on day 1 projects absurdly). |
| 7 | **The current month counts only through today**; future-dated entries wait for their day, as in the reports. | One bound; including them is simpler and contradicts the reports. |
| 8 | **Net-refund months are shown as negative used**, the bar clamps at zero. | Cosmetic. |
| 9 | **The record-time warning is in scope**, riding the existing `warnings` channel. | Cheap to drop (it is one function and a warning code); the screen warning stands alone. |
| 10 | **A dashboard line, only when something needs attention**; no budget widget. | Anything richer is a separate request. |
| 11 | **The past-months history is a table, not a chart.** | A chart is a later addition; the table is also the accessible alternative. |
| 12 | **Overlap is refused by the service under a ledger row lock**, not by a database exclusion constraint. | An exclusion constraint needs the `btree_gist` extension; moving to it later is contained. |
| 13 | **Deleting a ledger that a budget names is refused** with a message, as for rules. | Without it the foreign key surfaces as a raw error page. |
| 14 | **Hard delete for budgets**: they hold no money and nothing depends on them. | Soft delete would add a column and filters for no consumer. |
