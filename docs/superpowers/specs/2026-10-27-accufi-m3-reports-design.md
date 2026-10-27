# AccuFi M3 — Reports: design

**Status:** Draft for review. **Date:** 2026-10-27. **Builds on:** `2026-09-11-accufi-design.md` §8.3 (the six reports), §4.2, §6.4, §7.3, EC-9/10/20/23–25/32/38/39/62. M0–M2 are merged.

The user asked for the design to be drafted straight from the spec, without a question round. Everything the spec leaves open is decided here and listed in **Calls I made** at the end, each with what it costs if wrong.

## 1. Intent

AccuFi already answers "where does my money stand today?" (dashboard, ledger, investments). M3 answers "how did it get there, and where did it go?" over a chosen period. It is the milestone whose exit criterion is: **every headline figure drills through to its transactions.** A figure the user cannot trace to entries is a figure they will not trust, so traceability is the design's organising constraint, not a polish item.

The six reports, as the spec names them:

1. **Net worth over time** — assets, investments at valuation, liabilities, total, by month.
2. **Income vs expense** — monthly bars; transfers excluded by construction.
3. **Spending by ledger** — ranked, for a period.
4. **Income by source** — the same, for income.
5. **Account history** — running balance of one account.
6. **Investment growth** — what was put in versus what it is worth, per investment and for the portfolio.

Plus the dashboard's part of the exit criterion (§8).

## 2. Goals, non-goals, anti-goals

**Goals**
- Every figure on every report either is a sum of listed transactions or visibly reconciles to one (§5).
- One arithmetic: reports reuse `netWorth()`, `valueHolding()`, and the M2 valuation inputs. A report must never be a second implementation that can disagree with the dashboard.
- Honest about what is missing: a month with no known price is "not valued", never zero or cost (EC-23); an old price is marked stale (EC-24); an incomplete figure says so and names what it leaves out.
- Periods follow the user's timezone and financial year (§6.4, EC-38/39).
- Usable without sight of the chart: each chart has a table with the same numbers.

**Non-goals (M3)**
- Comparison with a previous period, trends, forecasts, anomaly flags.
- Reports by tag, by day of week, by merchant; cash-flow Sankey diagrams.
- CSV/PDF export or printing (data export is its own item, EC-64), saved or shared reports.
- Budgets (M5). The spend report is where a budget will later draw its "consumed" number, but it is not built here.
- Any new chart library. Any cached or stored aggregate (§9.4: nothing cached).

**Anti-goals (a failure even if every test passes)**
- A chart that drops an unvalued month to ₹0 or plots cost as value.
- A "Total" that differs by a paisa from the sum of the rows beside it, or from the same date's dashboard figure.
- Income vs expense that counts a bank-to-bank transfer, a card-bill payment, or an opening balance as income or spending.
- A drill-through that lands on a list whose entries do not add up to the figure clicked.
- Palette drift: no purple, no yellow, no new hues beyond the Graphite & Azure tokens plus the existing positive/negative.

## 3. Constraints

- Stack and layering unchanged (§9.2): `src/domain` is pure and imports nothing from Prisma, Next or server; repositories are the only code touching tables and take `userId` first; services orchestrate; `src/lib` holds serialisable view builders; `src/app` is Server Components passing plain props (paise as text, days as `CalendarDate`, never a bigint or Date).
- Money is integer paise (`bigint`), never `number`. Quantity stays scaled bigint.
- Aggregates are computed in SQL, never by loading every transaction into memory (EC-62). Valuation history is computed in memory from lots and price points, which are few.
- Soft-deleted transactions never count. Archived nodes always count (EC-32): archiving hides a node from pickers, it does not remove its history from a report.
- Reports exclude the future by default (EC-10): a range's end is clamped to today in the user's timezone, and a note says how many future-dated entries were left out.
- Cross-user isolation: every new repository method is tested with a foreign user's ids; the isolation e2e is extended to the report URLs.
- Both timezone test passes (`scripts/test-tz.sh`) must stay green; no period maths may read process-local time.

## 4. Meaning of the figures

These definitions are binding; the code and tests follow them.

**Classify by node kind, never by the sign of an amount** (§4.2).

| Figure | Definition, for a period [from, to] |
|---|---|
| Income (per source node) | Σ amount of live transactions **out of** that `INCOME_SOURCE` node dated in the period. A source is never a target (§5), so there is nothing to subtract. |
| Spending (per ledger node) | Σ **into** the `EXPENSE` node − Σ **out of** it (refunds, `EXPENSE → ASSET`). Can be negative for a period (EC-20): shown as is and labelled "net refund". |
| Excluded from both | The system nodes `OPENING_BALANCE` and `OPENING_BALANCE_CONTRA` (spec §4). They are real balances, so they do appear in net worth and account history. |
| Included in both | `REALISED_GAIN` (income) and `REALISED_LOSS` (spending), tagged "from investment sales" and shown as their own rows (spec §7.5: gains and losses land in the income and expense reports). |
| Never income or spending | `ASSET → ASSET`, `ASSET → LIABILITY` (card bill), `ASSET/LIABILITY → INVESTMENT`, `LIABILITY → ASSET` (loan disbursed). By kind, no sign test is needed. |
| Net saved | Income − spending for the period. |
| Balance of a node at day D | Σ in − Σ out of live transactions dated on or before D. Same as `sumBalances(userId, D)`. |
| Net worth at D | `netWorth(balances at D, valuations at D)`, the existing function. Liabilities shown as a positive amount owed. |
| Investment value at D | `valueHolding({lots, points, asOf: D})`: the lots acquired and disposals made by D, priced at the latest snapshot on or before D (EC-25). Past months are valued at the prices known **for that month**, not today's. |
| Invested (cost) at D | The investment node's balance at D. After disposals this is the cost basis of what is still held (the disposal posts the cost-basis leg out of the node), so value − invested = unrealised gain at D, matching the Investments screen. |

A month with no price for a held quantity, or an investment that still needs a quantity (legacy lot-less entries, "NEEDS_QUANTITY" in the M2 rulings), is **not valued** at that point. A `CONTRIBUTION_ONLY` investment is valued at its balance, as net worth already does.

## 5. Traceability: how a figure is proved

Every figure is one of two kinds, and each has its own proof.

**Flow figures** (income, spending, net saved, monthly bars, a node's in/out in account history): the figure is the signed sum of a set of transactions. The drill-through is a link to `/transactions` with a filter that selects exactly that set. A test per report asserts: *the filter's own sum equals the figure.*

**Balance figures** (net worth at a date, an account's running balance, an investment's value): a balance is the sum of everything before it, so listing "all of it" is not useful. These reports show **opening + movement = closing** for each period, and the drill-through lists the period's movement (the transactions touching that account or kind in that month). The opening and closing are checked against `sumBalances`. For investment value, the drill additionally links to the node's Investments screen, where lots and prices are listed.

To make the second half provable, the Transactions screen gains:
- A **filter by several nodes** (needed for a parent ledger that rolls up its children; encoding left to the builder, shown as "Involving: Food and 3 inside it").
- A **filtered total**: "Net into these ledgers ₹X" computed in SQL over the whole filtered set, not the loaded page. Defined as Σ amount into the named nodes − Σ out of them, counting only entries with exactly one side inside the set (movements inside the set cancel). This is the number a spending drill must equal. Shown only when a node filter is present.

## 6. The reports

### 6.1 Shared controls
One range control for all reports: **month** (pick one), **financial year** (pick one), **last 12 months**, **custom** from–to. Default: last 12 months. Choices offered start at the user's first transaction. The range is in the URL (`?range=…`), so a report can be bookmarked and the back button undoes a change. It is parsed strictly on the server; a bad range shows an error beside the control and falls back to the default.

- The end is clamped to today (§3). A custom range of more than 10 years is refused with a message (bounds the number of points).
- Series are **monthly**. A range that starts or ends mid-month gets partial first/last buckets, labelled with their real days ("1–15 Apr"). Account history uses **daily** points when the range is 93 days or shorter, monthly otherwise.
- A series starts at the user's first transaction month if the range begins earlier, with a note "history begins 4 Apr 2026" rather than a run of zeros that look like data.

### 6.2 Net worth over time (`/reports/net-worth`)
One total line, one point per month-end (the last point is today). Beneath it, a table: month, assets, investments, liabilities owed, total, with the movement drill (§5) on each month. Points where an investment could not be valued are **partial**: drawn hollow, the table row says "Excludes: Nifty Index Fund (no price)", and the total is the partial figure, as the dashboard does. A point valued on a stale price is marked stale.

### 6.3 Income vs expense (`/reports/cash-flow`)
Paired monthly bars (income, spending) with net saved per month, and range totals. Each bar and total drills to its flow set. Realised gains/losses are inside the bars and itemised in the table.

### 6.4 Spending by ledger (`/reports/spending`) and Income by source (`/reports/income`)
A ranked list for the range, biggest first (ties broken by name then id so the order is stable), with a share-of-total bar. One level of grouping (spec §12.1): a parent ledger is a row whose figure is its own direct entries plus its children, expandable to show "Direct" and each child. A parent's drill uses the multi-node filter. Net-negative ledgers are listed in a separate "Net refunds" block; the share column is shown only for rows when the total is positive, and shares are not forced to sum to 100% (each is rounded half-up to one decimal). The total row is the exact sum of all rows, refunds included.

### 6.5 Account history (`/reports/accounts?node=…`)
Pick one `ASSET` or `LIABILITY` node (archived included, marked). A running-balance line, and a table of period, opening, money in, money out, closing. A card or loan is shown as an amount owed. Drill: the period's entries for that node.

### 6.6 Investment growth (`/reports/investments`)
Portfolio view and a picker for one investment. Two series per view: **Invested** (cost of what is held) and **Value**, with the gap as unrealised gain; realised gains from sales are shown in the table's own column so a sale does not make the picture lie. Not-valued points break the value line (a gap, never a drop to zero). In the portfolio view a partial point compares **like with like**: gain is computed only over the valued investments, and the point says "covers 2 of 3". `CONTRIBUTION_ONLY` nodes are in the portfolio at cost on both lines (no growth by definition) and labelled. Drill: the node's Investments screen, and the month's entries.

## 7. Architecture

- `src/domain/periods.ts`: resolve a range (month / FY / last 12 months / custom) in a timezone with the FY start month; month buckets with partial ends; list of selectable months/FYs from a first date. Built on `calendar-date.ts` (`monthRange`, `financialYearRange`, `todayIn`).
- `src/domain/reports.ts`: pure aggregation: classify a flow by kind and system role; rank and roll up one level; running balance and opening/in/out/closing per bucket; share basis points (half-up). No Prisma types.
- `src/server/repositories/report-repository.ts`: SQL aggregates, all `userId`-scoped and ignoring deleted rows: (a) flow totals grouped by (node, month) over a range; (b) per-node signed deltas grouped by month up to a date, plus each node's balance before the range (so a series is a running sum in the domain, not N queries); (c) the filtered net for §5.
- `src/server/services/report-service.ts`: one function per report. Net worth and investment history read `readValuationInputs` **once** and call `valuationStatesFrom` per month-end; they pass monthly balances to the existing `netWorth()`.
- `src/lib/report-view.ts`: serialisable view types (paise as text).
- `src/app/reports/[report]/page.tsx` (+ `loading.tsx` skeleton, shared range control and report tabs); `/reports` redirects to net worth. A "Reports" item joins the nav.
- **Charts**: small hand-written SVG components (line, paired bars, horizontal bars) in `src/components/ui/`, using the existing tokens, `motion` for entry animation only when reduced motion is off, hover/focus tooltip as a client island, and a "view as table" alternative on every chart. The builder should read the `dataviz` skill for colour and accessibility rules before writing them; the contrast test (`tests/design/contrast.test.ts`) must cover the chart colours in both themes.

Aggregates are SQL; a 10-year monthly range is at most 120 buckets × nodes rows, which is small.

## 8. Dashboard (the rest of the exit criterion)

- A **This month** strip (income, spent, net saved) with each figure linking to the matching report for the month.
- The net worth card gets a 12-month trend line (from the report's own data) that links to the net worth report; assets, investments and liabilities link to the accounts that compose them (the existing ledger sections) and to the month's movement.
- Existing dashboard figures are untouched, and a test asserts the report's last point equals the dashboard's net worth.

## 9. Edge cases

| Case | Behaviour |
|---|---|
| New user, nothing entered | Each report shows an empty state pointing to "Record a transaction", not a flat chart of zeros. |
| Range before the first transaction | Series begins at the first month (§6.1). |
| Refund larger than spend (EC-20) | Negative net for the period, labelled "net refund"; excluded from share-of-total. |
| Backdated entry (EC-9) | Past figures recompute; nothing is frozen. |
| Future-dated entry (EC-10) | Not in any figure; counted in a note with a link to those entries. |
| Archived node (EC-32) | In every figure; listed with an "archived" tag. |
| Deleted transaction | In no figure. A restored one reappears. |
| Price entered for an older date (EC-25) | Past months revalue consistently with "latest price on or before the month-end". |
| Stale price at a past month-end (EC-24) | The point is marked stale, judged against that month-end. |
| Investment needing a quantity | Not valued at every point, named. |
| Sale and loss | Disposal gain/loss rows are in income/spending, itemised and tagged. |
| Month with no activity | A zero bucket, not a missing one. |
| Mid-month custom range | Partial buckets labelled with their days. |
| Timezone / FY start month differs from default | Month and FY boundaries follow the user's settings (EC-38/39). |
| Node id in the URL belongs to someone else, or does not exist | "Not found", no hint which. |
| Range over 10 years | Refused with a message. |

## 10. Testing

- **Domain** (pure, in both timezone passes): range resolution including FY across a year end, leap years, partial buckets; classification (every kind pair in §4.1 of the spec, system roles); roll-up and ranking ties; running balance; basis-point shares at half-way values.
- **Reconciliation** (real DB): per report, seed a ledger, then assert (a) rows sum to the total to the paisa, (b) the drill filter's `filtered total` equals the figure, (c) net worth series last point equals `getDashboard` net worth for the same day, (d) investment value at a past month equals `valueHolding` as of that day, (e) opening + movement = closing for account history.
- **Honesty**: unvalued, stale, partial and future-dated cases each have a test that the figure is flagged, not zero.
- **Isolation**: every new repository method with a foreign user's ids; e2e extension to report URLs using the existing exact leak detector.
- **e2e**: open each report, change the range, click a figure and land on a list whose total matches; theme toggle and reduced motion; keyboard reach of every drill link; chart table alternative.

## 11. What is left to the builder

Chart visuals and tooltip behaviour (within §2's palette rule and the table alternative), the exact encoding of the multi-node filter in the URL, copy for empty and partial states, the exact range-control layout, and the SQL shape (one query per aggregate is expected, not prescribed).

## 12. Calls I made (change any)

| # | Call | Costs if wrong |
|---|---|---|
| 1 | Reports are **monthly** (account history daily for ≤ 93 days); no weekly or yearly view. | Add a bucket size to `periods.ts`; moderate. |
| 2 | Default range is **last 12 months**, plus month / FY / custom pickers. "Last 12 months" is an extra on top of the spec's three. | Cosmetic. |
| 3 | **Realised gains and losses are inside** income and spending, itemised and tagged, with no toggle to hide them. | A hide toggle is a filter on two known system nodes; small. |
| 4 | Future-dated entries are **excluded with a count note** and no "include future" switch. | One more range parameter; small. |
| 5 | Balance figures drill to the **period's movement** and show opening + movement = closing, not to "every transaction ever". | Needs a different proof model; unlikely to be wanted. |
| 6 | The Transactions screen gains a **multi-node filter and a SQL filtered total** (the proof of §5). | Without it, parent-ledger drills cannot reconcile; this is the one change outside `/reports` that I consider required. |
| 7 | **Hand-written SVG charts**, no chart dependency. | Swapping to a library later is contained inside the chart components. |
| 8 | Past months are valued at the prices **known for that month** (not today's), so history can show "not valued" before the first price. | Using today's price would be simpler and would misstate history; I think this is right. |
| 9 | In the portfolio view a partial point compares **like with like** (valued investments only) and says how many it covers. | Alternative is hiding gain on partial points; simpler, less informative. |
| 10 | A parent ledger's row = its own direct entries + children; **net-negative ledgers go in a "Net refunds" block**; shares are not forced to 100%. | Cosmetic. |
| 11 | The dashboard change is a **This month strip, a trend line and links**, nothing more. | Anything richer is a separate request. |
| 12 | A custom range is capped at **10 years**. | One constant. |
