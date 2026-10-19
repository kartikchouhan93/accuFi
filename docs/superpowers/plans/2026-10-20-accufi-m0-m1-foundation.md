# AccuFi M0–M1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working, self-hosted AccuFi where a user can sign up, create ledger nodes of all five kinds, record single and split transactions between them, and see correct balances and net worth.

**Architecture:** A pure `src/domain` layer holds every arithmetic and policy rule (money, dates, flow legality, balances) and imports nothing from Prisma or Next. `src/server` wraps Prisma in repositories that take `userId` as their first argument and filter on it without exception. `src/app` holds thin Server Components and Server Actions that authenticate, validate with Zod, call a service, and render. Balances are never stored — they are summed from transactions on every read.

**Tech Stack:** Bun (runtime + package manager), Next.js 16.1.3 App Router, React 19.2.3, Tailwind 4, Prisma 6, PostgreSQL 16, Auth.js v5, Zod, Vitest, Playwright, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-11-accufi-design.md`

## Global Constraints

- All monetary values are integer paise as `bigint`. No `number`, no `float`, no decimal library for currency, anywhere. (Spec §6.1)
- `Transaction.occurredAt` is a Postgres `DATE`, never a timestamp. `createdAt` / `updatedAt` / `deletedAt` are `timestamptz`. (Spec §6.4)
- Every repository method takes `userId` as its first parameter and filters every query on it. A query that reaches Prisma without a `userId` filter is a defect. (Spec §9.5)
- A request for a row belonging to another user returns not-found, never forbidden. (Spec EC-8)
- `src/domain/**` must not import from `@prisma/client`, `next`, or `src/server/**`. Enforced by an ESLint `no-restricted-imports` rule in Task 1.
- Deletion is soft everywhere: `deletedAt` on transactions, `archivedAt` on nodes. Hard delete of a node is permitted only when it has zero transactions. (Spec EC-13, EC-33)
- A node's `kind` is immutable after creation. (Spec EC-34)
- Default user settings: `timezone = "Asia/Kolkata"`, `financialYearStartMonth = 4`, `stalePriceDays = 30`. (Spec §6.4, §7.3)
- Expense and income nodes support exactly one level of parent grouping. A node whose `parentId` is set may not itself be a parent. (Spec §12 item 1)
- Currency is INR only. Formatting uses Indian digit grouping: `₹1,23,456.78`. (Spec §6.1)

## Review Focus

These are the failure modes the spec implies that no task's happy path would catch. Each has a test pinned to the task that owns the code.

1. **`bigint` crossing the Server Action boundary.** `JSON.stringify` throws on `bigint`, so any Paise value returned from a Server Action or embedded in a Server Component's props crashes the request. Everything crossing the boundary must be a string. — tested in Task 11.
2. **`DATE` round-tripping through Prisma.** Prisma returns a `@db.Date` as a JS `Date` at UTC midnight. In `Asia/Kolkata` (UTC+5:30), naively formatting that with local-time methods yields the correct day, but any `toISOString()` after a local-time mutation silently shifts it a day. A transaction saved as 1 April must read back as 1 April. — tested in Task 3 and Task 6.
3. **Cross-user data access.** The highest-severity defect in this application. Every repository method must return nothing for a well-formed ID belonging to another user. — tested in Task 8.
4. **Double-submitted transaction create.** A slow network and an impatient click must not produce two identical transactions and a doubled balance. — tested in Task 11.
5. **Archived nodes.** They must disappear from entry pickers but remain fully functional in historical transactions, which must stay editable. Getting this backwards either corrupts history or strands it. — tested in Task 9 and Task 11.

---

## File Structure

```
prisma/
  schema.prisma                      Task 6
  seed.ts                            Task 7

src/domain/                          pure; no Prisma, no Next
  money.ts            money.test.ts            Task 2
  calendar-date.ts    calendar-date.test.ts    Task 3
  ledger-kind.ts      ledger-kind.test.ts      Task 4
  transaction-rules.ts  transaction-rules.test.ts  Task 4
  balance.ts          balance.test.ts          Task 5

src/server/
  db.ts                              Task 6   Prisma client singleton
  password.ts                        Task 7   argon2id wrapper
  auth.ts                            Task 7   Auth.js config
  repositories/
    node-repository.ts               Task 8
    transaction-repository.ts        Task 8
  services/
    node-service.ts                  Task 9
    transaction-service.ts           Task 11
    balance-service.ts               Task 14

src/lib/
  serialise.ts                       Task 2   Paise <-> string at the boundary
  schemas/node.ts                    Task 9
  schemas/transaction.ts             Task 11

src/app/
  (auth)/signup, (auth)/login        Task 7
  nodes/                             Task 10
  transactions/                      Task 13
  page.tsx  dashboard                Task 14
  api/health/route.ts                Task 1

Dockerfile, docker-compose.yml, .env.example   Task 1
```

---

### Task 1: Stack baseline and runtime spike

This task exists to answer the one open technical risk in the spec (§9.1) before any feature code is built on top of it: does Next.js 16 + Prisma 6 actually work on the Bun runtime, in Docker, against Postgres 16?

**Files:**
- Modify: `package.json` (rename to `accufi`, Bun scripts, add Prisma/Zod/Vitest)
- Delete: `package-lock.json`
- Create: `Dockerfile`, `docker-compose.yml`, `.env.example`, `prisma/schema.prisma` (minimal), `src/server/db.ts`, `src/app/api/health/route.ts`, `vitest.config.ts`
- Modify: `eslint.config.mjs` (domain-purity rule), `README.md`
- Test: `tests/smoke/health.test.ts`

**Interfaces:**
- Produces: `prisma` singleton from `src/server/db.ts`; `GET /api/health` returning `{ status: "ok", database: "up" }`.

- [ ] **Step 1: Write the failing smoke test**

```ts
// tests/smoke/health.test.ts
it("reports the database is reachable", async () => {
  const res = await fetch(`${process.env.APP_URL}/api/health`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ status: "ok", database: "up" })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun run test tests/smoke/health.test.ts`
Expected: FAIL — connection refused.

- [ ] **Step 3: Replace the npm toolchain with Bun**

Delete `package-lock.json`. Rename the package to `accufi`. Scripts: `dev` → `next dev`, `build` → `next build`, `start` → `next start`, `test` → `vitest run`, `test:watch` → `vitest`, `db:migrate` → `prisma migrate dev`, `db:deploy` → `prisma migrate deploy`, `db:studio` → `prisma studio`. Add `prisma`, `@prisma/client`, `zod`, `vitest`. Run `bun install` to generate `bun.lock`.

- [ ] **Step 4: Write the minimal Prisma schema and the health route**

`prisma/schema.prisma` with the `postgresql` datasource from `DATABASE_URL`, the `prisma-client-js` generator, and a single throwaway `model HealthCheck { id Int @id @default(autoincrement()) }` so there is something to migrate. `src/server/db.ts` exports a `PrismaClient` singleton guarded against hot-reload duplication. The health route runs `SELECT 1` and returns `database: "up"`, or a 503 with `database: "down"` when the query throws.

- [ ] **Step 5: Write the container setup**

`Dockerfile`: multi-stage on `oven/bun:1`, `bun install --frozen-lockfile`, `bunx prisma generate`, `bun run build`, final stage runs `bunx prisma migrate deploy && bun run start`. `docker-compose.yml` replaces the existing Postgres-only file: `postgres` on `postgres:16-alpine` with a named volume, credentials from `.env`, and a `pg_isready` healthcheck; `app` with `depends_on: postgres: condition: service_healthy`, port 3000. `.env.example` carries `DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `APP_URL`, `AUTH_SECRET`. Add `.env` to `.gitignore`.

- [ ] **Step 6: Add the domain-purity lint rule**

In `eslint.config.mjs`, a `no-restricted-imports` rule for `src/domain/**` banning `@prisma/client`, `next`, `next/*`, and `../server/*`. Add a `no-restricted-syntax` rule banning `parseFloat`, `Number(...)`, and `.toFixed(` on any identifier matching `/[Pp]aise|[Aa]mount|[Bb]alance/` — spec EC-1 wants the float path unavailable, not merely discouraged.

- [ ] **Step 7: Verify the whole stack**

Run: `docker compose up --build -d`, then `bun run test tests/smoke/health.test.ts`
Expected: PASS.
Also run `bun run build` and `bunx prisma migrate dev --name init` and confirm both succeed.

- [ ] **Step 8: Record the outcome of the spike**

In `README.md`, record the resolved Bun version and whether the Bun runtime worked. **If Prisma fails under Bun**, apply the documented fallback: change the Dockerfile's final stage to a Node 22 base, keep `bun install` in the build stage, and note it here. Do not attempt to work around a broken Prisma engine — take the fallback and move on. If Vitest misbehaves under Bun, switch to `bun test` and record that too.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: bun + next + prisma + postgres baseline in docker"
```

---

### Task 2: Money primitives

**Files:**
- Create: `src/domain/money.ts`, `src/lib/serialise.ts`
- Test: `src/domain/money.test.ts`

**Interfaces:**
- Produces:
```ts
export type Paise = bigint
export function parseRupees(input: string): Paise        // throws MoneyParseError
export function formatPaise(amount: Paise): string       // "₹1,23,456.78"
export function allocate(total: Paise, weights: readonly bigint[]): Paise[]
export class MoneyParseError extends Error {}
// src/lib/serialise.ts
export function serialisePaise(amount: Paise): string
export function deserialisePaise(value: string): Paise
```

- [ ] **Step 1: Write the failing tests**

```ts
describe("parseRupees", () => {
  it("parses plain and grouped input", () => {
    expect(parseRupees("1234.56")).toBe(123456n)
    expect(parseRupees("1,23,456.78")).toBe(12345678n)
    expect(parseRupees("100")).toBe(10000n)
    expect(parseRupees("0.05")).toBe(5n)
  })
  it("rejects more than two decimal places", () => {
    expect(() => parseRupees("1.234")).toThrow(MoneyParseError)
  })
  it("rejects non-numeric input", () => {
    expect(() => parseRupees("abc")).toThrow(MoneyParseError)
  })
})

describe("formatPaise", () => {
  it("uses Indian digit grouping", () => {
    expect(formatPaise(12345678n)).toBe("₹1,23,456.78")
    expect(formatPaise(10000n)).toBe("₹100.00")
    expect(formatPaise(0n)).toBe("₹0.00")
  })
  it("formats negative amounts with the sign before the symbol", () => {
    expect(formatPaise(-12345678n)).toBe("-₹1,23,456.78")
  })
})

describe("allocate", () => {
  it("distributes an indivisible remainder so the legs sum exactly", () => {
    expect(allocate(10000n, [1n, 1n, 1n])).toEqual([3334n, 3333n, 3333n])
  })
  it("allocates proportionally to weights", () => {
    expect(allocate(10000n, [3n, 1n])).toEqual([7500n, 2500n])
  })
  it("always sums to the total for arbitrary inputs", () => {
    // property test: 1000 random (total, weights) pairs
    // assert sum(allocate(total, weights)) === total
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun run test src/domain/money.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domain/money.ts`**

`allocate` is the only part the signature and tests do not determine: compute each leg as `total * weight / totalWeight` by integer division, then distribute the leftover paise one at a time to legs in descending order of their fractional remainder, ties broken by index. Assert before returning that the legs sum to `total`. `formatPaise` uses `Intl.NumberFormat("en-IN")` on the rupee and paise parts separately — do not pass a `bigint` through a float path.

- [ ] **Step 4: Implement `src/lib/serialise.ts`**

`serialisePaise` is `String(amount)`; `deserialisePaise` is `BigInt(value)` with a guard that rejects anything non-integral. These exist as named functions rather than inline conversions so the boundary is greppable.

- [ ] **Step 5: Run the tests**

Run: `bun run test src/domain/money.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/money.ts src/domain/money.test.ts src/lib/serialise.ts
git commit -m "feat(domain): money primitives in integer paise"
```

---

### Task 3: Calendar date primitives

Addresses Review Focus #2. A transaction happens on a day; this task makes that a type the rest of the system cannot get wrong.

**Files:**
- Create: `src/domain/calendar-date.ts`
- Test: `src/domain/calendar-date.test.ts`

**Interfaces:**
- Produces:
```ts
export type CalendarDate = string & { readonly __brand: "CalendarDate" }  // "YYYY-MM-DD"
export function calendarDate(value: string): CalendarDate     // throws on bad input
export function todayIn(timezone: string): CalendarDate
export function toDbDate(date: CalendarDate): Date            // UTC midnight
export function fromDbDate(date: Date): CalendarDate
export function compareDates(a: CalendarDate, b: CalendarDate): number
export function monthRange(year: number, month: number): { start: CalendarDate; end: CalendarDate }
export function financialYearRange(date: CalendarDate, startMonth: number): { start: CalendarDate; end: CalendarDate }
```

- [ ] **Step 1: Write the failing tests**

```ts
it("round-trips through the database representation without shifting", () => {
  const d = calendarDate("2026-04-01")
  expect(fromDbDate(toDbDate(d))).toBe("2026-04-01")
})

it("round-trips correctly when the process runs in Asia/Kolkata", () => {
  // run with TZ=Asia/Kolkata; a UTC-midnight Date is 05:30 local on the SAME day
  expect(fromDbDate(new Date("2026-04-01T00:00:00.000Z"))).toBe("2026-04-01")
})

it("round-trips correctly when the process runs west of UTC", () => {
  // run with TZ=America/New_York; UTC midnight is 20:00 the PREVIOUS day locally
  expect(fromDbDate(new Date("2026-04-01T00:00:00.000Z"))).toBe("2026-04-01")
})

it("rejects malformed and impossible dates", () => {
  expect(() => calendarDate("01-04-2026")).toThrow()
  expect(() => calendarDate("2026-02-30")).toThrow()
})

it("computes the Indian financial year from any date within it", () => {
  expect(financialYearRange(calendarDate("2026-01-15"), 4))
    .toEqual({ start: "2025-04-01", end: "2026-03-31" })
  expect(financialYearRange(calendarDate("2026-05-15"), 4))
    .toEqual({ start: "2026-04-01", end: "2027-03-31" })
})

it("clamps a month range to the real last day", () => {
  expect(monthRange(2027, 2).end).toBe("2027-02-28")
  expect(monthRange(2028, 2).end).toBe("2028-02-29")
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun run test src/domain/calendar-date.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/domain/calendar-date.ts`**

`fromDbDate` must read the UTC components (`getUTCFullYear`, `getUTCMonth`, `getUTCDate`) and never the local-time ones — that is the entire bug this task prevents. `toDbDate` builds the `Date` with `Date.UTC`. `todayIn` derives the date parts via `Intl.DateTimeFormat` with the given `timeZone`, not by offset arithmetic.

- [ ] **Step 4: Run the tests under two timezones**

Run: `bun run test src/domain/calendar-date.test.ts` then `TZ=America/New_York bun run test src/domain/calendar-date.test.ts`
Expected: PASS in both. Add the second invocation to the `test` script so it cannot regress.

- [ ] **Step 5: Commit**

```bash
git add src/domain/calendar-date.ts src/domain/calendar-date.test.ts package.json
git commit -m "feat(domain): timezone-safe calendar dates"
```

---

### Task 4: Flow legality and transaction validation

**Files:**
- Create: `src/domain/ledger-kind.ts`, `src/domain/transaction-rules.ts`
- Test: `src/domain/ledger-kind.test.ts`, `src/domain/transaction-rules.test.ts`

**Interfaces:**
- Consumes: `Paise` (Task 2), `CalendarDate` (Task 3)
- Produces:
```ts
export type LedgerKind = "INCOME_SOURCE" | "ASSET" | "INVESTMENT" | "EXPENSE" | "LIABILITY"
export type SystemNodeRole = "OPENING_BALANCE" | "REALISED_GAIN" | "REALISED_LOSS"
export const ALLOWED_FLOWS: ReadonlyArray<readonly [LedgerKind, LedgerKind]>
export function isFlowAllowed(from: LedgerKind, to: LedgerKind): boolean

export interface NodeSummary { id: string; kind: LedgerKind; archivedAt: Date | null; systemRole: SystemNodeRole | null }
export interface TransactionDraft { fromNode: NodeSummary; toNode: NodeSummary; amount: Paise; occurredAt: CalendarDate }
export type ViolationCode = "SAME_NODE" | "NON_POSITIVE_AMOUNT" | "ILLEGAL_FLOW" | "ARCHIVED_NODE"
export interface RuleViolation { code: ViolationCode; message: string }
export function validateTransaction(draft: TransactionDraft, opts?: { allowArchived?: boolean }): RuleViolation[]
```

- [ ] **Step 1: Write the failing matrix test**

Assert all 25 ordered pairs explicitly against spec §5 — do not loop over a copy of the implementation's own table. The 18 allowed pairs are every pair except: the five `* → INCOME_SOURCE`, plus `EXPENSE → INVESTMENT` and `EXPENSE → EXPENSE`.

```ts
it("permits income to reach assets, investments, expenses and liabilities", () => {
  expect(isFlowAllowed("INCOME_SOURCE", "ASSET")).toBe(true)
  expect(isFlowAllowed("INCOME_SOURCE", "EXPENSE")).toBe(true)   // TDS
})
it("never permits money to flow back into an income source", () => {
  for (const k of ALL_KINDS) expect(isFlowAllowed(k, "INCOME_SOURCE")).toBe(false)
})
it("permits an expense to refund only to an asset or a liability", () => {
  expect(isFlowAllowed("EXPENSE", "ASSET")).toBe(true)
  expect(isFlowAllowed("EXPENSE", "LIABILITY")).toBe(true)
  expect(isFlowAllowed("EXPENSE", "INVESTMENT")).toBe(false)
  expect(isFlowAllowed("EXPENSE", "EXPENSE")).toBe(false)
})
```

- [ ] **Step 2: Write the failing validation tests**

```ts
it("rejects a transaction from a node to itself", /* SAME_NODE */)
it("rejects a zero amount", /* NON_POSITIVE_AMOUNT */)
it("rejects a negative amount", /* NON_POSITIVE_AMOUNT */)
it("rejects an illegal kind pair naming both kinds in the message", /* ILLEGAL_FLOW */)
it("rejects an archived node by default", /* ARCHIVED_NODE */)
it("permits an archived node when allowArchived is set", /* [] — EC-14 */)
it("returns every applicable violation, not just the first", /* two codes */)
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `bun run test src/domain/ledger-kind.test.ts src/domain/transaction-rules.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement both modules**

`ALLOWED_FLOWS` is a literal array transcribed from spec §5 — write it out, do not generate it from a rule, so the table can be read against the spec. `validateTransaction` accumulates violations rather than returning on the first.

- [ ] **Step 5: Run the tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/ledger-kind.ts src/domain/ledger-kind.test.ts src/domain/transaction-rules.ts src/domain/transaction-rules.test.ts
git commit -m "feat(domain): flow legality matrix and transaction validation"
```

---

### Task 5: Balance and net worth arithmetic

**Files:**
- Create: `src/domain/balance.ts`
- Test: `src/domain/balance.test.ts`

**Interfaces:**
- Consumes: `Paise` (Task 2), `LedgerKind` (Task 4)
- Produces:
```ts
export interface NodeBalance { nodeId: string; kind: LedgerKind; balance: Paise }
export interface NetWorth {
  assets: Paise; investments: Paise; liabilities: Paise; total: Paise
  isPartial: boolean; unvaluedNodeIds: string[]
}
export function netWorth(
  balances: readonly NodeBalance[],
  valuations?: ReadonlyMap<string, Paise | null>,
): NetWorth
```

`valuations` maps an investment node to its current market value; `null` means the node has no price and cannot be valued. An investment absent from the map falls back to its contribution balance — which is the whole of M1's behaviour, since valuation arrives in M2.

- [ ] **Step 1: Write the failing tests**

```ts
it("sums assets and investments and subtracts liabilities", () => {
  const nw = netWorth([
    { nodeId: "a", kind: "ASSET", balance: 5000000n },
    { nodeId: "i", kind: "INVESTMENT", balance: 7000000n },
    { nodeId: "l", kind: "LIABILITY", balance: 1500000n },
  ])
  expect(nw.total).toBe(10500000n)
})
it("excludes income and expense totals from net worth", () => { /* adding either changes nothing */ })
it("prefers a supplied valuation over the contribution balance", () => { /* 7000000n -> 8500000n */ })
it("marks net worth partial and names nodes whose valuation is null", () => {
  expect(nw.isPartial).toBe(true)
  expect(nw.unvaluedNodeIds).toEqual(["i"])
})
it("excludes an unvalued investment from the total rather than counting it as zero or as cost", () => {})
it("returns an all-zero, non-partial result for no nodes", () => {})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun run test src/domain/balance.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `netWorth` in `src/domain/balance.ts`**

- [ ] **Step 4: Run the tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/balance.ts src/domain/balance.test.ts
git commit -m "feat(domain): net worth arithmetic with partial valuation"
```

---

### Task 6: Database schema

**Files:**
- Modify: `prisma/schema.prisma` (replace the Task 1 throwaway model)
- Create: `prisma/migrations/*` (generated), `tests/db/schema.test.ts`

**Interfaces:**
- Produces: models `User`, `LedgerNode`, `TransactionGroup`, `Transaction`; enums `LedgerKind`, `AssetSubtype`, `LiabilitySubtype`, `ValuationMode`, `LotMethod`, `SystemNodeRole`, `GroupKind`.

- [ ] **Step 1: Write the failing schema tests**

```ts
it("stores and returns occurredAt as the same calendar day", async () => {
  // write 2026-04-01 via toDbDate, read back via fromDbDate, expect "2026-04-01"
})
it("stores amounts above Number.MAX_SAFE_INTEGER without loss", async () => {
  // 9_007_199_254_740_993n round-trips exactly  (EC-4)
})
it("rejects two transactions with the same userId and idempotencyKey", async () => {
  // unique constraint violation  (EC-17)
})
it("permits many transactions with a null idempotencyKey", async () => {})
it("rejects a second system node with the same role for one user", async () => {})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun run test tests/db/schema.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the schema**

`User`: `id`, `email` (unique), `passwordHash`, `timezone` default `"Asia/Kolkata"`, `financialYearStartMonth` default `4`, `stalePriceDays` default `30`, `createdAt`.

`LedgerNode`: `id`, `userId`, `kind`, `name`, `parentId?`, `institution?`, `lastFour?`, `assetSubtype?`, `liabilitySubtype?`, `creditLimitPaise? BigInt`, `statementDay?`, `dueDay?`, `valuationMode?`, `unitLabel?`, `lotMethod?`, `stalePriceDays?` (per-node override), `blockNegative` default `false`, `systemRole?`, `archivedAt?`, `createdAt`. Indexes: `@@index([userId, kind])`, `@@unique([userId, systemRole])`.

`TransactionGroup`: `id`, `userId`, `kind GroupKind`, `createdAt`. `GroupKind` is `MANUAL_SPLIT | DISPOSAL | EMI` — only `MANUAL_SPLIT` is reachable in M1; the others are written now because adding an enum value later is a migration and this costs nothing.

`Transaction`: `id`, `userId`, `fromNodeId`, `toNodeId`, `amountPaise BigInt`, `occurredAt DateTime @db.Date`, `note?`, `tags String[]`, `groupId?`, `version Int @default(0)`, `idempotencyKey?`, `deletedAt?`, `createdAt`, `updatedAt`. Indexes: `@@unique([userId, idempotencyKey])`, `@@index([userId, toNodeId, occurredAt])`, `@@index([userId, fromNodeId, occurredAt])`, `@@index([userId, occurredAt])`.

All `createdAt` / `updatedAt` defaults are `dbgenerated("now()")` rather than Prisma-client-side `now()`, so every timestamp comes from the database and app/DB clock skew cannot reorder history (EC-66).

There is no `openingBalance` column anywhere — an opening balance is a transaction (spec §9.4, EC-36). There is no stored balance column anywhere (spec §9.4).

- [ ] **Step 4: Generate and apply the migration**

Run: `bunx prisma migrate dev --name core_ledger`
Expected: migration created and applied; `bunx prisma generate` succeeds.

- [ ] **Step 5: Run the tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add prisma/ tests/db/schema.test.ts
git commit -m "feat(db): core ledger schema"
```

---

### Task 7: Authentication and account creation

**Files:**
- Create: `src/server/password.ts`, `src/server/auth.ts`, `src/server/services/signup-service.ts`, `src/app/(auth)/signup/page.tsx`, `src/app/(auth)/login/page.tsx`, `middleware.ts`, `prisma/seed.ts`
- Test: `src/server/password.test.ts`, `tests/server/signup-service.test.ts`

**Interfaces:**
- Consumes: `prisma` (Task 1), `SystemNodeRole` (Task 4)
- Produces:
```ts
// src/server/password.ts
export function hashPassword(plain: string): Promise<string>
export function verifyPassword(plain: string, hash: string): Promise<boolean>
// src/server/services/signup-service.ts
export function createAccount(input: { email: string; password: string }): Promise<{ userId: string }>
export class EmailTakenError extends Error {}
// src/server/auth.ts
export const { auth, handlers, signIn, signOut }  // Auth.js v5
export function requireUserId(): Promise<string>  // throws if unauthenticated
```

- [ ] **Step 1: Write the failing tests**

```ts
it("verifies a password against its own hash", async () => {})
it("rejects a wrong password", async () => {})
it("produces a different hash for the same password each time", async () => { /* salted */ })

it("creates the three system nodes on signup", async () => {
  const { userId } = await createAccount({ email: "a@b.com", password: "correct horse" })
  const roles = (await prisma.ledgerNode.findMany({ where: { userId } })).map(n => n.systemRole)
  expect(roles.filter(Boolean).sort()).toEqual(["OPENING_BALANCE", "REALISED_GAIN", "REALISED_LOSS"])
})
it("gives the system nodes the right kinds", async () => {
  // OPENING_BALANCE and REALISED_GAIN are INCOME_SOURCE; REALISED_LOSS is EXPENSE
})
it("rejects a duplicate email", async () => { await expect(...).rejects.toThrow(EmailTakenError) })
it("never stores the plaintext password", async () => {})
it("creates the account and its system nodes atomically", async () => {
  // a failure seeding nodes must leave no user row behind
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun run test src/server/password.test.ts tests/server/signup-service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement password hashing**

argon2id via `@node-rs/argon2`. If that package will not build under Bun, use `Bun.password` (argon2id by default) behind the same two function signatures — the wrapper exists precisely so this choice is one file.

- [ ] **Step 4: Implement `createAccount`**

Everything inside one `prisma.$transaction`. Seed the three system nodes with `systemRole` set, plus a starter set of expense ledgers (Groceries, Rent, Utilities, Transport, Dining, Health) that the user may delete.

- [ ] **Step 5: Configure Auth.js and the route guard**

Credentials provider calling `verifyPassword`, Prisma adapter, database sessions. `middleware.ts` redirects unauthenticated requests to `/login` for everything except `/login`, `/signup`, and `/api/health`. `requireUserId()` re-checks the session rather than trusting a caller-supplied id — every Server Action calls it first.

- [ ] **Step 6: Build the signup and login pages**

- [ ] **Step 7: Rate-limit the auth endpoints**

Spec §9.5. A fixed-window counter keyed on IP plus submitted email, held in Postgres so it survives a restart and needs no new infrastructure: 10 attempts per 15 minutes, responding 429 beyond that. Test that the eleventh attempt is refused and that a successful login clears the counter.

- [ ] **Step 8: Run the tests**

Run: `bun run test src/server/password.test.ts tests/server/signup-service.test.ts tests/server/rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server/password.ts src/server/auth.ts src/server/services/signup-service.ts src/app/\(auth\) middleware.ts prisma/seed.ts src/server/password.test.ts tests/server/signup-service.test.ts
git commit -m "feat(auth): signup, login, and per-user system node seeding"
```

---

### Task 8: Repository layer with user scoping

Addresses Review Focus #3.

**Files:**
- Create: `src/server/repositories/node-repository.ts`, `src/server/repositories/transaction-repository.ts`
- Test: `tests/server/repositories/isolation.test.ts`, `tests/server/repositories/balances.test.ts`

**Interfaces:**
- Consumes: `prisma` (Task 1), `CalendarDate` (Task 3), `NodeBalance` (Task 5)
- Produces:
```ts
// node-repository.ts
export function findNodes(userId: string, filter?: { kinds?: LedgerKind[]; includeArchived?: boolean }): Promise<LedgerNode[]>
export function findNodeById(userId: string, nodeId: string): Promise<LedgerNode | null>
export function createNode(userId: string, data: CreateNodeData): Promise<LedgerNode>
export function updateNode(userId: string, nodeId: string, data: UpdateNodeData): Promise<LedgerNode>
export function deleteNode(userId: string, nodeId: string): Promise<void>
export function countTransactionsForNode(userId: string, nodeId: string): Promise<number>

// transaction-repository.ts
export interface TransactionFilter { nodeIds?: string[]; from?: CalendarDate; to?: CalendarDate; minAmount?: Paise; maxAmount?: Paise; tags?: string[]; search?: string }
export interface Page<T> { items: T[]; nextCursor: string | null }
export function findTransactions(userId: string, filter: TransactionFilter, cursor?: string, limit?: number): Promise<Page<Transaction>>
export function findTransactionById(userId: string, id: string): Promise<Transaction | null>
export function insertTransactions(userId: string, drafts: InsertDraft[], groupId?: string): Promise<Transaction[]>
export function updateTransaction(userId: string, id: string, data: UpdateDraft, expectedVersion: number): Promise<Transaction>
export function softDeleteTransaction(userId: string, id: string): Promise<void>
export function sumBalances(userId: string, asOf: CalendarDate): Promise<NodeBalance[]>
export class VersionConflictError extends Error { constructor(readonly current: Transaction) {} }
```

- [ ] **Step 1: Write the failing isolation tests**

A fixture creates two users each with their own nodes and transactions. Then, for **every exported read and write method**, assert that calling it with user A's id and user B's row id returns `null`, an empty list, or throws not-found — and in particular that no write mutates B's row.

```ts
it("findNodeById returns null for another user's node", async () => {})
it("updateNode does not modify another user's node", async () => {})
it("softDeleteTransaction does not delete another user's transaction", async () => {})
it("findTransactions never includes another user's rows", async () => {})
it("sumBalances excludes another user's transactions", async () => {})
// ...one per exported method; this list must stay exhaustive
```

- [ ] **Step 2: Write the failing balance tests**

```ts
it("computes a balance as inflows minus outflows", async () => {})
it("excludes soft-deleted transactions", async () => {})
it("excludes transactions after the asOf date", async () => { /* EC-10 */ })
it("returns a zero balance for a node with no transactions", async () => {})
it("sums amounts above Number.MAX_SAFE_INTEGER without precision loss", async () => {})
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `bun run test tests/server/repositories`
Expected: FAIL.

- [ ] **Step 4: Implement the repositories**

Every method's `where` begins with `userId`. `sumBalances` is the one place raw SQL is warranted, because Prisma cannot express the union:

```sql
SELECT node_id, SUM(delta)::text AS balance FROM (
  SELECT "toNodeId" AS node_id,  "amountPaise" AS delta FROM "Transaction"
   WHERE "userId" = $1 AND "deletedAt" IS NULL AND "occurredAt" <= $2
  UNION ALL
  SELECT "fromNodeId",          -"amountPaise"        FROM "Transaction"
   WHERE "userId" = $1 AND "deletedAt" IS NULL AND "occurredAt" <= $2
) m GROUP BY node_id
```

Cast the sum to `text` and parse it with `BigInt` — a Postgres `numeric` arriving as a JS `number` would silently lose precision. Pagination is keyset on `(occurredAt, id)`, never `OFFSET`. `updateTransaction` writes with `where: { id, userId, version: expectedVersion }` and increments `version`; a zero-row update throws `VersionConflictError` carrying the current row.

- [ ] **Step 5: Run the tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/repositories tests/server/repositories
git commit -m "feat(server): user-scoped repositories with derived balances"
```

---

### Task 9: Node service

Addresses Review Focus #5 (the picker half).

**Files:**
- Create: `src/server/services/node-service.ts`, `src/lib/schemas/node.ts`, `src/app/nodes/actions.ts`
- Test: `tests/server/node-service.test.ts`

**Interfaces:**
- Consumes: node repository (Task 8), `parseRupees` (Task 2), `requireUserId` (Task 7)
- Produces:
```ts
export function listNodesForPicker(userId: string, kinds?: LedgerKind[]): Promise<LedgerNode[]>  // excludes archived
export function createLedgerNode(userId: string, input: CreateNodeInput): Promise<LedgerNode>
export function renameLedgerNode(userId: string, nodeId: string, name: string): Promise<LedgerNode>
export function archiveLedgerNode(userId: string, nodeId: string): Promise<{ node: LedgerNode; residualBalance: Paise }>
export function restoreLedgerNode(userId: string, nodeId: string): Promise<LedgerNode>
export function removeLedgerNode(userId: string, nodeId: string): Promise<void>
export class SystemNodeError extends Error {}
export class NodeHasHistoryError extends Error {}
export class HierarchyDepthError extends Error {}
```

`CreateNodeInput` accepts an optional `openingBalance: Paise`; when present, `createLedgerNode` also writes a transaction from the user's `OPENING_BALANCE` system node (EC-36).

- [ ] **Step 1: Write the failing tests**

```ts
it("omits archived nodes from the picker but keeps them in the full list", /* EC-14, RF#5 */)
it("creates an opening-balance transaction when an opening balance is given", /* EC-36 */)
it("refuses to change a node's kind", /* EC-34 */)
it("refuses to rename or delete a system node", /* EC-37, SystemNodeError */)
it("hard-deletes a node that has no transactions", /* EC-33 */)
it("refuses to hard-delete a node that has transactions", /* NodeHasHistoryError */)
it("archives a node with a balance and reports the residual", /* EC-32 */)
it("warns but does not block on a duplicate node name", /* EC-35 */)
it("refuses to nest a node under a node that already has a parent", /* HierarchyDepthError */)
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun run test tests/server/node-service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the Zod schemas in `src/lib/schemas/node.ts`**

Kind-conditional: `assetSubtype` required when `kind === "ASSET"`, `liabilitySubtype` when `LIABILITY`, `valuationMode` and `unitLabel` when `INVESTMENT`. Use a discriminated union on `kind`.

- [ ] **Step 4: Implement the service and the Server Actions**

Each action calls `requireUserId()` first, parses with the Zod schema, calls the service, and returns a serialised result (no `bigint` — see Task 11 / Review Focus #1).

- [ ] **Step 5: Run the tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/services/node-service.ts src/lib/schemas/node.ts src/app/nodes/actions.ts tests/server/node-service.test.ts
git commit -m "feat(nodes): node lifecycle service with archive and system-node rules"
```

---

### Task 10: Node management UI

**Files:**
- Create: `src/app/nodes/page.tsx`, `src/app/nodes/node-form.tsx`, `src/app/nodes/node-list.tsx`
- Test: `tests/e2e/nodes.spec.ts`

**Interfaces:**
- Consumes: the Server Actions from Task 9.

- [ ] **Step 1: Write the failing Playwright test**

```ts
test("creates a bank account with an opening balance and shows it", async ({ page }) => {})
test("groups the list by kind", async ({ page }) => {})
test("archives an account and hides it from the list by default", async ({ page }) => {})
test("shows archived accounts when the filter is toggled", async ({ page }) => {})
test("does not offer rename or delete on a system node", async ({ page }) => {})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bunx playwright test tests/e2e/nodes.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Build the pages**

A list grouped by the five kinds, each row showing name, institution, and current balance. A create form whose fields change with the selected kind, mirroring the Task 9 discriminated union. Archive and restore as row actions, with the residual-balance warning from `archiveLedgerNode` surfaced before confirming.

- [ ] **Step 4: Run the test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/nodes tests/e2e/nodes.spec.ts
git commit -m "feat(nodes): node management UI"
```

---

### Task 11: Transaction service

Addresses Review Focus #1, #4, and the history half of #5.

**Files:**
- Create: `src/server/services/transaction-service.ts`, `src/lib/schemas/transaction.ts`, `src/app/transactions/actions.ts`
- Test: `tests/server/transaction-service.test.ts`, `tests/server/serialisation.test.ts`

**Interfaces:**
- Consumes: transaction + node repositories (Task 8), `validateTransaction` (Task 4), `serialisePaise` (Task 2)
- Produces:
```ts
export interface RecordTransactionInput {
  fromNodeId: string; toNodeId: string; amount: Paise
  occurredAt: CalendarDate; note?: string; tags?: string[]; idempotencyKey: string
}
export function recordTransaction(userId: string, input: RecordTransactionInput): Promise<TransactionView>
export function editTransaction(userId: string, id: string, input: EditTransactionInput, expectedVersion: number): Promise<TransactionView>
export function removeTransaction(userId: string, id: string): Promise<void>
export function restoreTransaction(userId: string, id: string): Promise<TransactionView>
export interface TransactionView { /* every Paise field is a string; every date is a CalendarDate */ }
export interface Warning { code: "OVERDRAWN" | "OVER_CREDIT_LIMIT" | "FUTURE_DATED"; message: string }
```

`TransactionView` is the boundary type: it contains **no `bigint` and no `Date`**. Everything that crosses into a Server Component or a client component crosses as this type.

- [ ] **Step 1: Write the failing serialisation tests**

```ts
it("returns no bigint anywhere in a TransactionView", () => {
  // walk the object recursively; assert typeof !== "bigint" at every leaf
})
it("survives JSON.stringify", () => {
  expect(() => JSON.stringify(view)).not.toThrow()   // RF#1
})
```

- [ ] **Step 2: Write the failing service tests**

```ts
it("records a legal transaction and moves both balances", /* EC core */)
it("rejects an illegal flow with the domain's message", /* EC-7 */)
it("returns the first result for a replayed idempotency key", /* EC-17, RF#4 */)
it("creates only one row when the same key is submitted twice concurrently", /* RF#4 */)
it("warns but does not block when an asset would go negative", /* EC-11 */)
it("blocks an overdraft when the account sets blockNegative", /* EC-11 */)
it("warns but does not block when a card exceeds its credit limit", /* EC-12 */)
it("accepts a backdated transaction and changes past balances", /* EC-9 */)
it("accepts a future-dated transaction and excludes it from the current balance", /* EC-10 */)
it("permits editing a transaction that references an archived node", /* EC-14, RF#5 */)
it("throws VersionConflictError when the expected version is stale", /* EC-18 */)
it("soft-deletes and restores, with balances following", /* EC-13 */)
it("permits a refund larger than the original spend", /* EC-20 */)
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `bun run test tests/server/transaction-service.test.ts tests/server/serialisation.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the service**

Load both nodes, build a `TransactionDraft`, call `validateTransaction` with `allowArchived: true` on an edit of an existing row and `false` on a create. Warnings are computed after validation and returned alongside the result — never thrown. Idempotency rides on the unique constraint from Task 6: insert, and on a unique-violation return the existing row rather than erroring.

- [ ] **Step 5: Run the tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/services/transaction-service.ts src/lib/schemas/transaction.ts src/app/transactions/actions.ts tests/server/transaction-service.test.ts tests/server/serialisation.test.ts
git commit -m "feat(transactions): record, edit and delete with idempotency and optimistic locking"
```

---

### Task 12: Split groups

**Files:**
- Modify: `src/server/services/transaction-service.ts`, `src/lib/schemas/transaction.ts`
- Test: `tests/server/split-group.test.ts`

**Interfaces:**
- Consumes: `allocate` (Task 2), `recordTransaction` internals (Task 11)
- Produces:
```ts
export interface SplitLegInput { toNodeId: string; amount: Paise; note?: string }
export function recordSplit(userId: string, input: {
  fromNodeId: string; occurredAt: CalendarDate; legs: SplitLegInput[]
  tags?: string[]; idempotencyKey: string
}): Promise<TransactionView[]>
export function ungroupTransaction(userId: string, id: string): Promise<TransactionView>
export class SplitTotalMismatchError extends Error {}
```

- [ ] **Step 1: Write the failing tests**

```ts
it("writes every leg with one shared groupId", /* §4 */)
it("writes all legs or none", async () => {
  // an illegal leg rolls the whole group back  (EC-57 pattern)
})
it("rejects legs that do not sum to a stated total", /* SplitTotalMismatchError, EC-3 */)
it("splits 100.00 three ways so the legs sum exactly", () => {
  // [3334n, 3333n, 3333n]  — EC-5 via allocate()
})
it("validates each leg against the flow matrix independently", /* EC-7 */)
it("collapses a two-leg group to a plain transaction when one leg is removed", /* EC-19 */)
it("deletes the whole group when a group member is deleted", /* EC-13 */)
it("records an EMI as principal to the loan and interest to an expense", /* §4.1 */)
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun run test tests/server/split-group.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `recordSplit` and `ungroupTransaction`**

One `prisma.$transaction` creates the `TransactionGroup` and all legs. Validate every leg before writing any. A group reduced to one member has its `groupId` cleared and the empty group row removed.

- [ ] **Step 4: Run the tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/services/transaction-service.ts src/lib/schemas/transaction.ts tests/server/split-group.test.ts
git commit -m "feat(transactions): split groups with exact remainder allocation"
```

---

### Task 13: Transaction entry and list UI

**Files:**
- Create: `src/app/transactions/page.tsx`, `src/app/transactions/transaction-form.tsx`, `src/app/transactions/transaction-list.tsx`, `src/app/transactions/filters.tsx`
- Test: `tests/e2e/transactions.spec.ts`

**Interfaces:**
- Consumes: the Server Actions from Tasks 12 and 13.

- [ ] **Step 1: Write the failing Playwright tests**

```ts
test("records a salary credit and updates the account balance", async ({ page }) => {})
test("offers only legal destinations once a source is chosen", async ({ page }) => {})
test("omits archived accounts from the pickers", async ({ page }) => { /* RF#5 */ })
test("records a split across two expense ledgers from one form", async ({ page }) => {})
test("shows the overdraft warning but still saves", async ({ page }) => {})
test("filters by account and by date range", async ({ page }) => {})
test("loads the next page without duplicating rows", async ({ page }) => {})
test("double-clicking save creates exactly one transaction", async ({ page }) => { /* RF#4 */ })
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bunx playwright test tests/e2e/transactions.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Build the entry form**

One form for every flow. Choosing the source filters the destination picker through `isFlowAllowed`. An "add split" control turns the single destination into a leg list whose amounts must sum to the entered total, with a "divide equally" helper calling `allocate`. The form generates its `idempotencyKey` once per open — not per submit — which is what makes the double-click test pass.

- [ ] **Step 4: Build the list**

Default to the current month. Filters for node, kind, date range, amount range, tag, and note text. Keyset pagination. Split groups render as one row that expands to its legs.

- [ ] **Step 5: Run the tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/transactions tests/e2e/transactions.spec.ts
git commit -m "feat(transactions): entry form and filterable list"
```

---

### Task 14: Dashboard

**Files:**
- Create: `src/server/services/balance-service.ts`, `src/app/page.tsx`, `src/app/net-worth-card.tsx`, `src/app/account-summary.tsx`
- Test: `tests/server/balance-service.test.ts`, `tests/e2e/dashboard.spec.ts`

**Interfaces:**
- Consumes: `sumBalances` (Task 8), `netWorth` (Task 5)
- Produces:
```ts
export interface DashboardView {
  netWorth: { assets: string; investments: string; liabilities: string; total: string; isPartial: boolean }
  accounts: Array<{ id: string; name: string; kind: LedgerKind; balance: string }>
  projected: { total: string; asOf: CalendarDate } | null   // includes future-dated rows (EC-10)
}
export function getDashboard(userId: string, asOf?: CalendarDate): Promise<DashboardView>
```

- [ ] **Step 1: Write the failing tests**

```ts
it("computes net worth across assets, investments and liabilities", async () => {})
it("excludes future-dated transactions from the current figure and reports them as projected", /* EC-10 */)
it("returns a coherent empty state for a brand-new account", async () => {})
it("treats an investment with no valuation as a contribution balance in M1", async () => {})
it("renders every amount as a string", /* RF#1 */)
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun run test tests/server/balance-service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `getDashboard`**

Call `sumBalances` twice — once at today, once with no upper bound — and derive `projected` from the difference. Pass the results through `netWorth` from Task 5. Serialise every `Paise` on the way out.

- [ ] **Step 4: Build the dashboard**

A net-worth card with the assets / investments / liabilities split, a per-account summary grouped by kind, and the most recent ten transactions. An empty state that points a brand-new user at creating their first account.

- [ ] **Step 5: Write and run the e2e test**

```ts
test("a full month reconciles", async ({ page }) => {
  // salary -> bank, rent, card spend, card bill payment, an SIP, a transfer to cash
  // assert the dashboard net worth equals the hand-computed figure exactly
})
```

Run: `bunx playwright test tests/e2e/dashboard.spec.ts`
Expected: PASS. **This is M1's exit criterion** (spec §11).

- [ ] **Step 6: Commit**

```bash
git add src/server/services/balance-service.ts src/app/page.tsx src/app/net-worth-card.tsx src/app/account-summary.tsx tests/server/balance-service.test.ts tests/e2e/dashboard.spec.ts
git commit -m "feat(dashboard): balances and net worth"
```

---

## Out of scope for this plan

Deferred to their own plans against the same spec: investment lots, price snapshots and disposals (M2); reports (M3); recurring rules (M4); budgets (M5); CSV import (M6). Also deferred, both deliberately rather than by oversight:

- **Account deletion (EC-63)** — needs a settings area that M1 does not otherwise have. The cascade is already expressible in the schema; only the UI and the typed-email confirmation are outstanding.
- **Data export (EC-64)** — the spec assigns it to no milestone. It belongs with M3 or later, once there is more than one entity worth exporting.
