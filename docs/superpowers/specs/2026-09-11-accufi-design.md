# AccuFi — Product Requirements & Design

**Status:** Draft for review
**Date:** 2026-09-11
**Repository:** https://github.com/kartikchouhan93/accuFi

---

## 1. Overview

AccuFi is a personal finance tracker. A user records where money comes from, which accounts it lands in, and where it goes from there — spent, moved between accounts, or invested. The system answers three questions at any point in time:

1. **What do I have?** — balance of every account, current value of every investment, outstanding on every debt, and the net worth those add up to.
2. **Where did it go?** — income by source, spending by ledger, transfers between accounts, over any period.
3. **How is it growing?** — contributions versus present value for each investment, and net worth over time.

The distinguishing requirement is investment tracking with real cost basis: gold recorded as *weight bought at a price*, mutual funds as *units bought at a NAV*, property as *a lump acquired at a price* — each revalued against a manually maintained price history so growth is a computed fact rather than a guess.

### 1.1 Goals

- One consistent model for every movement of money, so that adding a new kind of account or ledger requires no new code path.
- Balances and net worth that are always correct, derived from transactions rather than maintained as mutable counters.
- Investment valuation that never silently misleads — a stale price is labelled as stale, never presented as today's value.
- Self-hostable with `docker compose up`.

### 1.2 Non-goals (v1)

- Bank API / account aggregator integration. All data arrives by manual entry or CSV.
- Automatic price feeds for gold, NAV, or property. Prices are entered by hand; the design keeps a seam for a feed later (§7.4).
- Multi-currency. Everything is INR (§6.1).
- Shared or household accounts. Each user's data is fully isolated (§3).
- Tax computation or filing.
- Mobile apps. Responsive web only.
- Bill reminders, notifications, email.
- Receipt and document attachments — they require object storage in the compose stack (§12, open question 2).

### 1.3 Success criteria

- A user can reconstruct a month of real financial activity — salary, rent, card spending, a card bill payment, an SIP, a gold purchase — and the resulting net worth matches a hand calculation to the paisa.
- Selling an appreciated asset produces a correct realised gain without the investment's contribution balance going negative.
- Every arithmetic rule in §6 and every case in §10 is covered by an automated test.

---

## 2. Prior art in this repository

The repo currently holds a stock `create-next-app` scaffold and nothing else:

| File | Contents | Disposition |
|---|---|---|
| `package.json` | Next 16.1.3, React 19.2.3, Tailwind 4, TypeScript 5, ESLint 9. Package name `finance-platform`. | **Keep** the dependency baseline. Rename to `accufi`. Replace npm scripts with Bun equivalents. |
| `package-lock.json` | npm lockfile | **Delete** — replaced by `bun.lock`. |
| `app/` | Default `layout.tsx`, `page.tsx`, `globals.css`, favicon | **Replace.** No application logic exists. |
| `docker-compose.yml` | Postgres 15-alpine only, credentials hardcoded, no app service | **Rewrite** (§9.3). Postgres 16, app service, env from `.env`, healthcheck. |
| `README.md` | create-next-app boilerplate | **Rewrite.** |
| `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs` | Defaults | **Keep,** adjust as needed. |

There is no schema, no database access, no auth, and no domain logic to preserve. Treat this as a greenfield build on an existing scaffold.

---

## 3. Users and tenancy

Multi-user, with each user owning a private, non-shared set of data. There is no concept of a household, a shared budget, or an invited collaborator.

Every row that belongs to a user carries `userId`. Isolation is enforced in the repository layer (§9.2), not in individual route handlers — a query that reaches Prisma without a `userId` filter is a bug the architecture is designed to make hard to write.

---

## 4. Core concepts

**Ledger node** — anything money can come from, sit in, or go to. Five kinds:

| Kind | What it represents | Examples | Has a balance? |
|---|---|---|---|
| `INCOME_SOURCE` | An external origin of money | Employer salary, freelance client, rent received, interest credited | No — it is a flow total |
| `ASSET` | Money you hold and can spend | HDFC Savings, ICICI Current, cash in wallet, Paytm balance | Yes |
| `INVESTMENT` | Money you hold that is not directly spendable and may change in value | Sovereign gold, an MF scheme, a plot of land, an FD | Yes, two ways (§7) |
| `EXPENSE` | A category money disappears into | Groceries, fuel, dining, rent paid, school fees | No — it is a flow total |
| `LIABILITY` | Money you owe | HDFC credit card, home loan, personal loan | Yes — negative when you owe (§4.2) |

**Transaction** — one movement of money from exactly one node to exactly one node, on a given date, for a positive amount. Direction carries the sign; amounts are never negative.

**Split group** — two or more transactions that happened as one real-world event, linked by a shared `groupId` and entered and displayed as a unit. A shopping trip divided across two expense ledgers, an EMI divided into principal and interest, an asset sale divided into cost basis and gain.

**Investment lot** — a single acquisition of a quantity of something at a unit cost. Created by any transaction targeting an `INVESTMENT` node.

**Price snapshot** — a dated unit price for an investment node, entered by the user.

**Opening position** — a node's starting balance, recorded as an ordinary transaction rather than a column (§9.4, EC-36). A *positive* opening position posts `OPENING_BALANCE → node`. A *negative* one — a card you already owe on, an overdrawn account — posts `node → OPENING_BALANCE_CONTRA`, a per-user system node of kind `EXPENSE`. The contra node exists because `INCOME_SOURCE` can never be a target (§5), so without it there is no legal edge that makes a balance negative at setup. Both opening-balance system nodes are excluded from income and expense reports by their `systemRole`.

### 4.1 Every flow, one shape

| Real-world event | Transaction |
|---|---|
| Salary credited | `INCOME_SOURCE → ASSET` |
| Groceries paid by UPI | `ASSET → EXPENSE` |
| Groceries paid by credit card | `LIABILITY → EXPENSE` |
| Credit card bill paid | `ASSET → LIABILITY` |
| Moving money between own banks | `ASSET → ASSET` |
| ATM withdrawal | `ASSET → ASSET` (bank to cash) — **not** an expense |
| SIP installment | `ASSET → INVESTMENT` |
| Buying gold | `ASSET → INVESTMENT` |
| Selling gold at a profit | Split: `INVESTMENT → ASSET` (cost basis) + `INCOME_SOURCE:Realised Gain → ASSET` (gain) |
| Selling gold at a loss | Split: `INVESTMENT → ASSET` (proceeds) + `INVESTMENT → EXPENSE:Realised Loss` (loss) |
| EMI payment | Split: `ASSET → LIABILITY` (principal) + `ASSET → EXPENSE:Interest` |
| Loan disbursed into account | `LIABILITY → ASSET` |
| Refund from a merchant | `EXPENSE → ASSET` |
| Opening balance when you start using AccuFi | `INCOME_SOURCE:Opening Balance → ASSET` |

The uniformity is the point: one entry form, one list view, one balance formula, one set of report queries.

### 4.2 Net worth

```
net worth = Σ ASSET balances
          + Σ INVESTMENT current values   (§7.3)
          + Σ LIABILITY balances          (already negative — see below)
```

**Sign convention, stated once and binding everywhere.** Every node's balance is `inflows − outflows`, with no per-kind special case. A liability you owe money on is therefore **negative**: a card spend is `LIABILITY → EXPENSE`, an outflow from the card. Net worth adds that negative figure rather than subtracting it.

For display, `NetWorth.liabilities` is reported as a **positive magnitude owed** — the negation of the summed liability balances — so the UI can render "Liabilities ₹45,000" and the total reads `assets + investments − liabilities`. The arithmetic and the presentation agree; what must never happen is subtracting an already-negative balance, which would make borrowing look like wealth.

`INCOME_SOURCE` and `EXPENSE` totals never enter net worth. This is also what prevents an `ASSET → ASSET` transfer from being miscounted as income or spending in reports: reports classify by node **kind**, never by the sign of an amount.

---

## 5. Transaction legality

Allowed `(fromKind, toKind)` pairs are stored as a seeded reference table and validated on every create and edit. Storing it as data rather than code means the matrix can be inspected, tested, and extended without touching the service layer.

|  from ↓ / to → | `INCOME_SOURCE` | `ASSET` | `INVESTMENT` | `EXPENSE` | `LIABILITY` |
|---|---|---|---|---|---|
| `INCOME_SOURCE` | ✗ | ✓ salary, refund of income | ✓ employer PF / ESOP | ✓ TDS, deductions at source | ✓ income applied straight to a loan |
| `ASSET` | ✗ | ✓ own transfer, ATM | ✓ buy, SIP | ✓ spend | ✓ card bill, EMI |
| `INVESTMENT` | ✗ | ✓ redemption | ✓ fund switch | ✓ fees, realised loss | ✓ redemption applied to a loan |
| `EXPENSE` | ✗ | ✓ refund | ✗ | ✗ | ✓ refund onto the card used |
| `LIABILITY` | ✗ | ✓ cash advance, loan disbursal | ✓ investing on borrowed money | ✓ card spend | ✓ balance transfer |

Rules that hold regardless of the matrix:

- `fromNodeId ≠ toNodeId`.
- Both nodes belong to the requesting user.
- Amount is strictly greater than zero.
- Neither node is archived — **except** when editing a historical transaction that already references an archived node (§10, EC-14).

`INCOME_SOURCE` is never a target: money cannot flow back into an origin. A returned salary or a cancelled invoice is recorded as `ASSET → EXPENSE:Income Reversal`, or by correcting the original transaction.

---

## 6. Money, quantity, and time

### 6.1 Amounts

All monetary values are **integer paise**, stored as `BigInt` in Postgres and TypeScript. No `Float`, no `Number` arithmetic on money, no `Decimal` for currency. `₹1,234.56` is `123456`.

Display uses the Indian grouping convention — `₹1,23,456.78`, and lakh/crore abbreviations where a compact figure is wanted.

### 6.2 Quantities

Investment quantities are `Decimal(18, 6)`:

| Asset type | Unit | Typical precision |
|---|---|---|
| Gold / silver | gram | 3 decimals |
| Mutual fund | unit | 4 decimals (SIPs routinely produce e.g. `142.3871`) |
| Property, FD, lump assets | unit (always exactly `1`) | 0 |

Unit price is also integer paise, per single unit.

### 6.3 Split rounding

Splitting ₹100.00 three ways cannot produce three equal integers. The rule: compute each leg by integer division, then distribute the remainder one paisa at a time to the legs in descending order of magnitude (ties broken by entry order). The legs must sum to exactly the original amount; this is asserted in code and covered by a property-based test.

The same rule governs percentage-based splits and any proportional allocation in reports.

### 6.4 Dates and time

`occurredAt` is a **`DATE`**, not a timestamp. A transaction happens on a day, not at an instant, and storing it as a timestamp is the single most reliable way to produce off-by-one-day bugs when the server and the user are in different zones.

`createdAt`, `updatedAt`, `deletedAt` are `timestamptz` — these are system events and genuinely instantaneous.

Each user has a `timezone` (default `Asia/Kolkata`) and a `financialYearStartMonth` (default `4`, i.e. 1 April). Period boundaries for reports, budgets, and recurrence are computed in the user's timezone against the user's financial year.

---

## 7. Investments and valuation

### 7.1 Valuation modes

Each `INVESTMENT` node declares a `valuationMode`:

| Mode | Behaviour | Fits |
|---|---|---|
| `QUANTITY` | Tracks lots of `quantity × unitCost`. Current value = total quantity × latest unit price. | Gold, silver, mutual funds, stocks |
| `LUMP` | A single lot of quantity `1`. The "unit price" is the whole asset's valuation. | Property, plots, a vehicle |
| `CONTRIBUTION_ONLY` | No lots, no prices. Value = net contributions. | FD at face value, PPF, anything you do not wish to revalue |

`LUMP` is deliberately implemented as `QUANTITY` with quantity fixed at 1, so one code path handles both. A plot "revalued to ₹45,00,000" is a price snapshot of `4500000_00` paise for one unit.

### 7.2 Lots

Every transaction targeting an `INVESTMENT` in `QUANTITY` or `LUMP` mode creates exactly one `InvestmentLot`:

```
quantity           Decimal(18,6)
quantityRemaining  Decimal(18,6)   -- reduced by disposals (§7.5)
costBasisPaise     BigInt          -- authoritative; equals the transaction amount
unitCostPaise      BigInt          -- derived, for display only
acquiredAt         Date            -- copied from the transaction
transactionId      FK, unique      -- one lot per acquiring transaction
```

`costBasisPaise` is authoritative and always equals the acquiring transaction's amount exactly. `unitCostPaise` is derived from it by division and is therefore approximate — `quantity × unitCostPaise` may differ from the cost basis by a paisa or two, and no calculation is ever allowed to depend on that product. The user enters any two of {amount, quantity, unit price} and the third is computed.

A monthly SIP therefore produces one lot per installment, each at that month's NAV — which is exactly what is needed for correct cost basis on a partial redemption.

### 7.3 Prices and current value

`PriceSnapshot` rows are `(nodeId, asOf DATE, pricePerUnitPaise, source)`. `source` is `MANUAL` in v1.

- **Current value** at date *D* = `Σ (remaining quantity of open lots) × (price snapshot with the greatest asOf ≤ D)`.
- If no snapshot exists at or before *D*, the node has **no valuation** at *D*. It is not zero and it is not the cost basis. Reports show it as "not valued" and net worth shows a clearly marked partial figure.
- A snapshot older than the staleness window is labelled in the UI — "as of 12 Mar 2026" — and never rendered as though it were today's price. The window is `stalePriceDays`, a user-level default of 30 with a nullable per-node override: 30 days is right for gold and NAV and absurd for a plot of land.
- Snapshots may be entered out of order; ordering is by `asOf`, not by insertion.
- `(nodeId, asOf)` is unique; re-entering a price for a date overwrites it.

Unrealised gain = current value − cost basis of open lots.

### 7.4 Price provider seam

Valuation reads prices through a single `PriceResolver` interface with one v1 implementation backed by the snapshot table. A future feed (gold rate API, AMFI NAV file) implements the same interface and writes snapshots with `source = FEED`. No valuation logic changes. This seam costs nothing now and is the only concession made to a deferred feature.

### 7.5 Disposals — the central edge case

Approach A gives every transaction exactly two sides, which creates a problem on a profitable sale. Gold bought for ₹70,000 and sold for ₹85,000 recorded as a single `INVESTMENT → ASSET` of ₹85,000 would drive the investment node's contribution balance to −₹15,000, which is meaningless.

**Resolution.** A disposal always posts as a split group:

*Gain:*
```
INVESTMENT → ASSET                       ₹70,000   (cost basis of lots consumed)
INCOME_SOURCE "Realised Gain" → ASSET    ₹15,000   (system node)
```

*Loss* (bought ₹70,000, sold ₹62,000):
```
INVESTMENT → ASSET                       ₹62,000
INVESTMENT → EXPENSE "Realised Loss"      ₹8,000   (system node)
```

Both system nodes are created per user at signup, flagged `isSystem`, and cannot be renamed into something else or deleted. The result: the investment node's contribution balance always reduces by exactly the cost basis removed, and gains and losses land in the income and expense reports where they belong.

**Lot consumption** is FIFO by default, configurable per node to LIFO or highest-cost-first. Partial consumption is supported: selling 8g when lots are 10g @ ₹7,000 and 5g @ ₹7,400 consumes all of the first lot and 3g of the second, for a cost basis of ₹70,000 + ₹22,200 = ₹92,200. Each `InvestmentLot` carries `quantityRemaining`, and a `LotConsumption` join table records which disposal consumed which lots and how much — without it, editing or deleting a disposal cannot be unwound correctly.

---

## 8. Feature specifications

### 8.1 M1 — Foundation

**Authentication.** Email and password via Auth.js v5. Sessions use the JWT strategy, not database sessions — Auth.js forces JWT whenever a Credentials provider is used, so the combination originally written here does not exist. Passwords hashed with argon2id. Signup seeds the user's system nodes (Opening Balance, Opening Balance Contra, Realised Gain, Realised Loss) and a starter set of expense ledgers the user may delete.

**Node management.** Create, rename, archive, and restore nodes of any kind. Kind is fixed at creation and cannot be changed — a node's kind determines the meaning of every transaction already pointing at it. Kind-specific fields:

- `ASSET`: subtype (`SAVINGS` / `CURRENT` / `CASH` / `WALLET`), institution, last four digits, and an optional opening balance — a convenience on the create form that posts an ordinary transaction, not a stored column (§9.4, EC-36). A positive figure posts from the Opening Balance node; a negative one posts to the Opening Balance Contra node (§4, "Opening position").
- `LIABILITY`: subtype (`CREDIT_CARD` / `LOAN`), institution, credit limit, statement day, due day, and an optional opening balance on the same terms as `ASSET`.
- `INVESTMENT`: `valuationMode`, unit label (`gram`, `unit`, …), lot consumption method.
- `INCOME_SOURCE`, `EXPENSE`: name and optional parent for one level of grouping.

**Transactions.** Create, edit, soft-delete, restore. Fields: from, to, amount, date, note, optional tags. Split entry adds legs sharing a `groupId`, with the remainder rule of §6.3 applied when the user enters a total and divides it.

**Listing.** Cursor-paginated, filterable by node, kind, date range, amount range, tag, and free text over notes. Default view is the current month.

**Balances.** Every node's balance, and net worth, derived on read (§9.4).

### 8.2 M2 — Investments

Lots, price snapshots, valuation, disposals with FIFO consumption, per-node holding view (lots, cost basis, current value, absolute and percentage gain), and a portfolio view across all investment nodes.

Price entry is a small dedicated screen: pick a node, enter a price and a date, see the resulting revaluation before saving.

### 8.3 M3 — Reports

- **Net worth over time** — a line per month, split into assets, investments at valuation, and liabilities.
- **Income vs expense** — monthly bars over a selectable range, with transfers excluded by construction (§4.2).
- **Spending by ledger** — ranked breakdown for a period, drillable to the transactions behind each figure.
- **Income by source** — the same for income.
- **Account history** — running balance for one account over time.
- **Investment growth** — contributions versus current value per node, over time.

Every report honours the user's financial year (§6.4) and offers calendar-month, financial-year, and custom ranges. Every figure is drillable to its underlying transactions — a total nobody can explain is a total nobody trusts.

### 8.4 M4 — Recurring entries

A `RecurringRule` holds a transaction template plus a schedule: frequency (`DAILY` / `WEEKLY` / `MONTHLY` / `QUARTERLY` / `YEARLY`), interval, day-of-month or day-of-week, start date, optional end date or occurrence count.

**Propose, do not post.** By default a due rule generates a `PendingOccurrence` that the user confirms, edits, or dismisses. Real salaries vary; real SIPs fail. A per-rule `autoPost` flag is available for the genuinely fixed cases.

Generation runs on a scheduled job and also opportunistically on user login, so a self-hosted instance that was switched off for a week catches up rather than silently skipping.

### 8.5 M5 — Budgets

A `Budget` sets a monthly cap on an `EXPENSE` node: amount, start month, optional end month, rollover flag (default off).

Spend against a budget is the sum of transactions targeting that node within the period, minus refunds out of it. The UI shows consumed, remaining, and a projection based on elapsed days. Exceeding a budget warns; it never blocks.

Budgets may be set on a parent ledger, in which case children roll up into it.

### 8.6 M6 — CSV import

Five stages, nothing committed until the last:

1. **Upload.** File hashed; an identical prior upload warns before proceeding.
2. **Map.** Choose delimiter, encoding, header row, and an **explicit** date format. Map columns to amount, date, description, and either a signed-amount column or separate debit and credit columns. Mappings save as a reusable per-institution profile.
3. **Preview.** First twenty rows parsed and shown as they will be recorded.
4. **Review.** All rows staged in `ImportRow` with a status. Each row needs a counterpart node; the importer suggests one from description-matching rules learned from previous imports, and the user confirms or overrides. Probable duplicates — matching date, amount, and direction against an existing transaction within a ±3-day window — are flagged for a decision, never dropped silently.
5. **Commit.** All accepted rows written in a single database transaction. Partial commits are not possible; a failure leaves the batch reviewable and the ledger untouched.

Every imported transaction carries its `importBatchId` and `importRowId`, so a bad import can be reversed wholesale.

---

## 9. Architecture

### 9.1 Stack

| Concern | Choice | Note |
|---|---|---|
| Runtime & package manager | Bun | `bun install`, `bun run`, `bun test` |
| Framework | Next.js App Router (16.1.3 baseline, already in repo) | Server Components for reads, Server Actions for writes |
| UI | React 19.2.3, Tailwind 4 | Already in repo |
| ORM | Prisma 6 | |
| Database | PostgreSQL 16 | Upgraded from the 15-alpine currently in compose |
| Auth | Auth.js v5 + Prisma adapter | |
| Validation | Zod, schemas shared client and server | |
| Unit / integration tests | Vitest | |
| E2E | Playwright | |
| Container | Multi-stage Dockerfile on the Bun image | |

**Risk.** Running Next.js and Prisma on the Bun runtime is less trodden than Node. Mitigation: the first task of M1 is a spike proving `bun run dev`, `bun run build`, `prisma migrate`, and `prisma generate` all work end to end in Docker. If Prisma's engine misbehaves under Bun, the fallback is Bun as package manager with Node as the runtime — a one-line Dockerfile change that affects nothing else in this document.

### 9.2 Layers

```
src/domain/     Pure TypeScript. Balance arithmetic, FIFO lot allocation,
                split remainder distribution, recurrence expansion, budget
                math, valuation. Imports nothing from Prisma or Next.
                Exhaustively unit-tested.

src/server/     Repositories and services. The only layer that touches
                Prisma. Every repository method takes userId as its first
                argument and every query filters on it.

src/app/        Next.js routes, Server Components, Server Actions. Thin:
                authenticate, validate with Zod, call a service, render.

src/lib/        Zod schemas, formatting, shared types.
```

The domain layer's purity is what makes the money rules testable without a database, and the money rules are where the bugs that matter live.

### 9.3 Docker

`docker-compose.yml` is rewritten to run `app` and `postgres`:

- Postgres 16 with a named volume, a healthcheck, and credentials from `.env` rather than hardcoded.
- `app` depends on Postgres being healthy, runs migrations on start, exposes 3000.
- `.env.example` committed; `.env` git-ignored.
- A `dev` override mounting source for hot reload.

### 9.4 Balances are derived, never cached

Node balances and net worth are computed on read by SQL aggregation over transactions:

```
balance(node) = Σ amount where toNodeId   = node and not deleted
              − Σ amount where fromNodeId = node and not deleted
```

There is no `openingBalance` column. An opening balance is an ordinary transaction from the system Opening Balance node (EC-36), which keeps it visible, editable, and correctable like any other figure.

with indexes on `(userId, toNodeId, occurredAt)` and `(userId, fromNodeId, occurredAt)`.

A cached balance column is the most common source of "my numbers are wrong" in finance software, because every edit, delete, backdate, and import must remember to adjust it, and one missed path corrupts the figure permanently and invisibly. At personal-finance volume — tens of thousands of rows — aggregation is a few milliseconds.

If profiling ever shows this is too slow, the documented lever is a monthly `BalanceRollup` table with a full-recompute command, added behind the same service interface. Not in v1.

### 9.5 Security

- Session checked in middleware; every Server Action re-checks rather than trusting the caller.
- `userId` scoping at the repository layer. **Cross-user IDOR is the highest-severity risk in this application** — a bug here shows one person's finances to another. Every repository method is tested with a second user's IDs to confirm it returns nothing.
- Zod validation on every input, including numeric ranges and node ownership.
- CSRF handled by Server Actions' built-in protection.
- Rate limiting on auth endpoints.
- No financial data in URLs or logs.

---

## 10. Edge cases

These are requirements, not notes. Each gets a test.

### Amounts and arithmetic

| # | Case | Behaviour |
|---|---|---|
| EC-1 | Floating-point money error | Impossible by construction: integer paise everywhere (§6.1). Lint rule bans `parseFloat` and `Number` on money fields. |
| EC-2 | Zero or negative amount | Rejected at validation. Direction carries sign. |
| EC-3 | Split legs not summing to the total | Rejected. Remainder distribution per §6.3 guarantees exactness; an assertion fires if it ever does not. |
| EC-4 | Amount exceeding safe integer range | `BigInt` end to end; serialised as string over the wire. |
| EC-5 | Percentage split producing repeating decimals | Same remainder rule as EC-3. |

### Transactions

| # | Case | Behaviour |
|---|---|---|
| EC-6 | `from` equals `to` | Rejected. |
| EC-7 | Illegal kind pair | Rejected against the §5 matrix, with a message naming both kinds. |
| EC-8 | Node belonging to another user | Rejected as not-found, never as forbidden — a forbidden response confirms the row exists. |
| EC-9 | Backdated transaction | Allowed. Balances, budgets, and reports for the affected past periods recompute; nothing is frozen. |
| EC-10 | Future-dated transaction | Allowed. Excluded from "current balance"; surfaced separately as a projected balance. Reports default to excluding the future. |
| EC-11 | Overdrawing an asset account | Warned, not blocked — out-of-order entry is normal. An opt-in per-account `blockNegative` flag is available. |
| EC-12 | Card spend beyond the credit limit | Warned, not blocked. |
| EC-13 | Deleting a transaction | Soft delete. Balances recompute. If the transaction created a lot, the lot is removed; if it consumed lots, the consumption is reversed and `quantityRemaining` restored. Blocked if reversal would leave a later disposal without enough quantity — the later disposal must be corrected first. |
| EC-14 | Editing a transaction that references an archived node | Permitted, so history stays correctable. Archived nodes never appear in pickers for new entries. |
| EC-15 | Editing amount, quantity, or date of a lot-creating transaction | The lot updates in lockstep. Rejected if the lot is already partly consumed and the new quantity is smaller than what has been consumed. |
| EC-16 | Editing a transaction's `from` or `to` | Revalidated against the matrix. Changing the target away from an `INVESTMENT` deletes the lot, subject to EC-15. |
| EC-17 | Double-submitted create | Client-generated idempotency key, unique per user; the second request returns the first result. |
| EC-18 | Two tabs editing the same transaction | Optimistic locking on a `version` column. The loser is shown a conflict with both versions. |
| EC-19 | Breaking one leg out of a split group | Allowed; a group of one is collapsed to a plain transaction. Groups arising from disposals (§7.5) are edited as a unit only. |
| EC-20 | Refund larger than the original spend | Allowed — genuine for a returned item plus goodwill. The ledger total simply goes negative for the period, and the report labels it. |

### Investments

| # | Case | Behaviour |
|---|---|---|
| EC-21 | Selling more quantity than held | Rejected, stating the quantity available. |
| EC-22 | Partial disposal across lots | FIFO by default, per-node override. `LotConsumption` records the allocation (§7.5). |
| EC-23 | No price snapshot for a node | Node reported as "not valued". Never zero, never cost basis. Net worth is marked partial and names the unvalued nodes. |
| EC-24 | Stale price | Displayed with its `asOf` date, and flagged once older than `stalePriceDays` (default 30). |
| EC-25 | Price entered for a date before existing snapshots | Accepted. Resolution is always "greatest `asOf` ≤ report date", so history stays consistent. |
| EC-26 | Two prices for the same date | `(nodeId, asOf)` is unique; the later write replaces the earlier. |
| EC-27 | Quantity precision loss | `Decimal(18,6)` in the database and in the domain layer. Never converted to a JS `number`. |
| EC-28 | Disposal of a `CONTRIBUTION_ONLY` node | No lots; recorded as a plain `INVESTMENT → ASSET`. Any excess over contributions must be entered explicitly as a gain leg. |
| EC-29 | Deleting an investment node with lots | Archive only. Hard delete permitted only when the node has no transactions at all. |
| EC-30 | Revaluing a `LUMP` asset (a plot) | A price snapshot for quantity 1. Growth is computed identically to gold. |
| EC-31 | An SIP producing hundreds of lots | Expected. The holdings view aggregates by default and expands to per-lot detail on request. |

### Accounts and nodes

| # | Case | Behaviour |
|---|---|---|
| EC-32 | Archiving a node with a non-zero balance | Warned. For assets and liabilities, the user is prompted to transfer the residue out first. Archiving is permitted regardless — the balance remains in history **and in net worth**. Balance summation therefore includes archived nodes; excluding them from the picker is a separate, display-only concern. Archiving a card you still owe on must not raise your net worth. |
| EC-33 | Hard-deleting a node with history | Not permitted. Archive is the only option once a transaction references the node. |
| EC-34 | Changing a node's kind | Not permitted. Every transaction pointing at it derives meaning from its kind. The user creates a new node and moves history explicitly. |
| EC-35 | Duplicate node names | Permitted but warned. Names are not identifiers. |
| EC-36 | Setting an opening balance after transactions exist | Allowed. The opening-balance transaction is a real, editable transaction against the appropriate system node — Opening Balance for a positive position, Opening Balance Contra for a negative one. |
| EC-37 | Deleting a system node | Blocked. |

### Dates, periods, timezones

| # | Case | Behaviour |
|---|---|---|
| EC-38 | Server and user in different timezones | `occurredAt` is a `DATE` (§6.4). User timezone governs every period boundary. |
| EC-39 | Financial year not matching the calendar | `financialYearStartMonth` per user, default April. |
| EC-40 | Monthly recurrence on the 31st in February | Clamped to the last day of the month. Never rolls into March. |
| EC-41 | Recurrence spanning a DST change | Dates are resolved in the user's zone; no UTC arithmetic on calendar dates. |
| EC-42 | A leap-day recurrence | Falls to 28 February in non-leap years. |

### Recurring

| # | Case | Behaviour |
|---|---|---|
| EC-43 | Instance missed while the server was down | Catch-up generates every occurrence due since `lastRunAt`, capped at 100 per rule per run to bound a pathological gap. |
| EC-44 | Rule edited after instances were posted | Only future occurrences change. Posted transactions are untouched. |
| EC-45 | Rule deleted with pending occurrences | Pending occurrences are removed; posted ones remain. |
| EC-46 | A recurring entry also arriving via CSV import | The importer matches pending occurrences within a ±3-day, same-amount window and offers to link rather than duplicate. |
| EC-47 | A pending occurrence never confirmed | It ages in an inbox and is excluded from balances until confirmed. Never silently posted. |

### Budgets

| # | Case | Behaviour |
|---|---|---|
| EC-48 | Budget created mid-month | Applies to the whole month. Prorating is not offered — it confuses more than it helps. |
| EC-49 | Backdated spend pushing a closed period over budget | Recomputed and shown as a retrospective overspend. History is not frozen. |
| EC-50 | Rollover of unspent budget | Off by default; opt-in per budget, accumulating across consecutive periods. |
| EC-51 | Budget on a parent ledger | Children roll up. A child may also carry its own budget; both are evaluated. |
| EC-52 | Refund into a budgeted ledger | Reduces consumption for the period in which the refund occurred. |

### Import

| # | Case | Behaviour |
|---|---|---|
| EC-53 | Ambiguous date format (`03/04/2026`) | Format is chosen explicitly at mapping. Never inferred. |
| EC-54 | Re-uploading the same file | File hash matched against prior batches; warned before proceeding. |
| EC-55 | Duplicate against an existing transaction | Flagged on the review screen — same date ±3 days, same amount, same direction. The user decides. Never auto-dropped. |
| EC-56 | Malformed row mid-file | That row is marked errored with its reason; the rest still stage. Nothing commits until review. |
| EC-57 | Commit failing partway | Single database transaction; rolls back entirely. The batch remains reviewable. |
| EC-58 | Non-UTF-8 encoding | Encoding selectable at mapping; a preview shows the result before committing. |
| EC-59 | Separate debit and credit columns | Supported as an alternative to a single signed column. |
| EC-60 | Reversing a bad import | Every row carries `importBatchId`; the whole batch soft-deletes in one action. |

### System

| # | Case | Behaviour |
|---|---|---|
| EC-61 | Cross-user data access | Repository-layer `userId` scoping, tested per method with a foreign user's IDs (§9.5). |
| EC-62 | Very large transaction counts | Cursor pagination; no offset paging. Aggregates computed in SQL, never in application memory. |
| EC-63 | Account deletion | Cascades all user-owned rows. Confirmation requires typing the account email. |
| EC-64 | Data portability | Full JSON and CSV export of every entity, sufficient to reconstruct the ledger. |
| EC-65 | Concurrent writes to the same node's balance | No stored balance to contend over — balances are derived (§9.4). |
| EC-66 | Clock skew between app and database | All server timestamps come from the database (`now()`), never the application process. |

---

## 11. Milestones

Each is independently shippable and leaves the application in a usable state.

| Milestone | Contents | Exit criterion |
|---|---|---|
| **M0** | Bun + Next + Prisma + Postgres running in Docker; the §9.1 runtime spike resolved | `docker compose up` gives a working app against a migrated database |
| **M1** | Auth, nodes, transactions, splits, derived balances, net worth | A month of real activity entered by hand reconciles to the paisa |
| **M2** | Lots, price snapshots, valuation, FIFO disposals, holdings view | Buy 10g gold, buy 5g more, sell 8g at a profit — cost basis, realised gain, and remaining holding are all correct |
| **M3** | Reports and dashboard | Every headline figure drills through to its transactions |
| **M4** | Recurring rules and the pending-occurrence inbox | A missed week catches up correctly; a 31st-of-the-month rule survives February |
| **M5** | Budgets | Backdated spend correctly reopens a closed period's overspend |
| **M6** | CSV import | A real bank statement imports with duplicates flagged and the batch reversible |

---

## 12. Open questions

1. ~~**Tags versus a category hierarchy.**~~ **Resolved 2026-10-20:** one level of parent grouping on expense and income nodes, plus free tags. Deeper hierarchy is frequently requested and rarely used, and it would complicate every report's roll-up.
2. **Attachments.** Receipts against transactions were considered and deferred; they need object storage in the compose stack. Deferred to post-v1.
3. ~~**`stalePriceDays` default.**~~ **Resolved 2026-10-20:** user-level default of 30 with a nullable per-node override (§7.3).
4. **Recurrence representation.** A structured schedule is specified rather than RRULE strings. If genuinely irregular schedules turn up, RRULE is the upgrade path.

---

## 13. Decision log

| Decision | Alternative rejected | Reason |
|---|---|---|
| One node table, two-sided transactions | Separate income / expense / transfer tables | Balance calculation would union three tables; credit-card-to-expense fits none of them cleanly; each new flow type would need a migration |
| Two legs plus split groups | Full n-legged double-entry journals | Gets nearly all the correctness at a fraction of the query complexity, without imposing accounting vocabulary on the UI |
| Integer paise | Decimal, or float | Exactness, and no dependence on a decimal library's rounding mode |
| Derived balances | Cached balance column | Cached balances drift; the drift is silent and permanent |
| Manual prices with history | Auto-fetch feeds | No external dependency, no API keys, no staleness ambiguity — and a growth chart still works. §7.4 keeps the seam |
| Single currency (INR) | Multi-currency | Would make every balance and every report currency-aware for a need that does not exist |
| Disposals as split groups with system gain and loss nodes | Allowing an investment balance to absorb gains | Keeps contributions and gains distinct, and keeps gains visible in income reports |
| Recurring proposes rather than posts | Auto-posting by default | Real amounts vary and real payments fail; a ledger that invents transactions cannot be trusted |
