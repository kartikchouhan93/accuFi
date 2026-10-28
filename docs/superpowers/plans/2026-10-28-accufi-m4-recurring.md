# AccuFi M4 — Recurring entries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user describes a repeating entry once; AccuFi proposes each occurrence when it falls due in an inbox; the user posts, edits, or skips it, and nothing reaches a balance until it is posted.

**Architecture:** A pure schedule module (`src/domain/recurrence.ts`) computes dates from an anchor. Two new tables (`RecurringRule`, `RecurringOccurrence`) hold the template and the proposals. A generation service creates pending occurrences (locked per rule, unique per `(ruleId, dueOn)`), run by an hourly in-process timer and after sign-in. Posting goes through the existing `recordTransaction` with an idempotency key derived from the occurrence.

**Tech Stack:** Bun, Next.js 16 App Router (Server Components, Server Actions, `instrumentation.ts`), React 19, Prisma 6 / PostgreSQL, Zod 4, Tailwind 4, Vitest, Playwright. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-28-accufi-m4-recurring-design.md` (parent: `2026-09-11-accufi-design.md` §8.4, EC-40 to EC-47). Amended at planning: a rule carries an optional `idempotencyKey` (unique per user), so a double-submitted "create rule" makes one rule, as a transaction does (EC-17). Task 11 records this in the spec.

## Global Constraints

- Money is integer paise (`bigint`, type `Paise`); across the server/client boundary it is paise **text**. Days are `CalendarDate` strings and `DATE` columns, crossed only through `toDbDate` / `fromDbDate`. Date arithmetic uses UTC components only: no instants, no process-local time (EC-41). Both timezone passes (`sh scripts/test-tz.sh`) must stay green.
- "Today" is the user's today (`todayFor(userId)`), never the server's.
- Layering: `src/domain` is pure (no Prisma, Next or server imports; value imports of other domain/lib code are **relative**). Repositories take `userId` first and put it in every query and join; they are the only code touching the two new tables. Services orchestrate. `src/app/**` Server Components pass plain props. No Server Component writes during render.
- Catch-up cap: `MAX_DUE_PER_RUN = 100` occurrences per rule per run (EC-43). A rule edit changes only future occurrences; posted transactions are never touched (EC-44). Deleting a rule removes its PENDING occurrences and keeps POSTED and DISMISSED ones; posted transactions remain (EC-45). A pending occurrence is excluded from every balance and report until posted (EC-47).
- Month-end clamp never drifts or rolls over (EC-40); a leap-day rule falls to 28 February in non-leap years (EC-42). `dayOfMonth` 31 means "last day".
- Posting idempotency key: `recurring:<occurrenceId>` (always at least 16 characters).
- Soft-deleted rows never count. Cross-user isolation is tested per repository method with a foreign user's ids, and the isolation e2e covers `/recurring`.
- Palette: Graphite & Azure tokens only. No purple, no yellow. Keyboard reachable, visible focus, reduced motion respected, light and dark through the existing tokens.
- No new dependency. No cached balance. `nextDueOn` is a schedule cursor, not a figure.
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Test commands: a file in both zones `sh scripts/test-tz.sh <path>`; everything `bun run test` (tsc plus both passes); `bun run lint` stays clean. A task's last step runs both.

## Review Focus

The inputs the spec implies and no obvious task test would reach; each has a test in the task named.

1. A user whose "today" differs from the server's UTC date (Pacific/Kiritimati, Pacific/Pago_Pago): the user's date decides what is due. (Task 6)
2. A leap-day yearly rule edited later: re-anchoring on 28 Feb must not lose the 29th. (Task 7)
3. A node archived after the rule exists: nothing generates, the rule says why, restoring catches up; a pending occurrence into an archived node can still be skipped and posting says why not. (Tasks 5, 6)
4. A double click on Post, or two tabs posting the same occurrence: one transaction. Posting after the rule was deleted in another tab: a clear "no longer exists", not a crash. (Tasks 5, 8)
5. A start date years in the past, or a daily rule left running for a year with the app off: bounded, no gap, no repeat. (Tasks 6, 7)

---

### Task 1: Settle the scheduled-job risk (sweep timer and `instrumentation.ts`)

The spec's "scheduled job" is an in-process timer started from `register()`. The production container runs `bun --bun run start`. This task proves it runs there, before anything depends on it.

**Files:**
- Create: `src/server/sweep-timer.ts`, `src/instrumentation.ts`, `tests/server/sweep-timer.test.ts`
- Create: `docs/superpowers/decisions/2026-10-28-m4-rulings.md` (R1 records the outcome)
- Modify: `.env.example` or README "Deployment" section (document `RECURRING_SWEEP`, `RECURRING_SWEEP_INTERVAL_MS`); `playwright.config.ts` (`env` of the web server gains `RECURRING_SWEEP: "off"`)

**Interfaces:**
- Produces:
  - `startSweepTimer(options: { run: () => Promise<void>; intervalMs?: number; env?: Record<string, string | undefined>; log?: Pick<Console, "error"> }): { stop(): void } | null` — `null` when `env.RECURRING_SWEEP === "off"`. Default `intervalMs` 3_600_000, overridable by `env.RECURRING_SWEEP_INTERVAL_MS` (a positive integer; anything else is ignored). Runs `run` once immediately (not awaited), then every interval; a tick that finds the previous run still going is skipped; a rejection is logged with `log.error` and never thrown; the timer is `unref`'d.
  - `src/instrumentation.ts`: `export async function register()` — returns unless `process.env.NEXT_RUNTIME === "nodejs"`, then dynamically imports a module and starts the timer. In this task the run function is a stub that logs one line `[recurring-sweep] tick`; Task 6 replaces the stub.

- [ ] **Step 1: Write the failing tests** in `tests/server/sweep-timer.test.ts` with `vi.useFakeTimers()`: (a) `run` is called once immediately and again after one interval; (b) with `env: { RECURRING_SWEEP: "off" }` it returns `null` and never calls `run`; (c) a `run` that never settles is not started twice by the next tick; (d) a rejecting `run` calls `log.error` once and the next tick still runs; (e) `RECURRING_SWEEP_INTERVAL_MS: "2000"` is honoured and `"abc"` falls back to the default; (f) `stop()` ends the ticks.
- [ ] **Step 2: Run to verify it fails.** Run: `sh scripts/test-tz.sh tests/server/sweep-timer.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `src/server/sweep-timer.ts` to the signature above, and `src/instrumentation.ts`.
- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS in both zones.
- [ ] **Step 5: Prove it in the production runtime.** Run `bun run build`, then `RECURRING_SWEEP_INTERVAL_MS=2000 bun --bun run start -p 3301` against the dev database for about 7 seconds. Expected: the log shows `[recurring-sweep] tick` at least three times (startup plus two intervals). Repeat with `RECURRING_SWEEP=off`: no ticks. Record the commands, the output and the Bun and Next versions in R1 of the rulings file.
- [ ] **Step 6: If no ticks appear** (the fallback in design §11): add `POST /api/recurring/sweep` (`src/app/api/recurring/sweep/route.ts`) that answers 401 unless the `x-sweep-secret` header equals `process.env.RECURRING_SWEEP_SECRET` (compared with `timingSafeEqual`; 503 when the variable is unset), add the path to `isPublicPath` in `src/server/auth.config.ts` (it authenticates itself), and document a one-line cron example in the README. Record in R1 that the fallback is in use, and report DONE_WITH_CONCERNS.
- [ ] **Step 7: Add `RECURRING_SWEEP: "off"` to the e2e web server env, run `bun run test` and `bun run lint`, then commit** `feat(recurring): sweep timer started from instrumentation, proven under bun start`.

---

### Task 2: The schedule (domain)

**Files:**
- Create: `src/domain/recurrence.ts`, `src/domain/recurrence.test.ts`
- Modify: `src/domain/calendar-date.ts` (add `isoWeekday`), `src/domain/calendar-date.test.ts`

**Interfaces:**
- Produces, in `calendar-date.ts`: `isoWeekday(date: CalendarDate): number` (Monday 1 … Sunday 7).
- Produces, in `recurrence.ts` (imports only relative domain modules):
  - `RECURRENCE_FREQUENCIES = ["DAILY","WEEKLY","MONTHLY","QUARTERLY","YEARLY"] as const`; `type RecurrenceFrequency`.
  - `MAX_DUE_PER_RUN = 100`, `INTERVAL_MAX = 99`, `OCCURRENCE_LIMIT_MAX = 1000`.
  - `interface Schedule { frequency: RecurrenceFrequency; interval: number; dayOfMonth: number | null; dayOfWeek: number | null; startDate: CalendarDate; endDate: CalendarDate | null; occurrenceLimit: number | null }`.
  - `normaliseSchedule(input: Omit<Schedule,"dayOfMonth"|"dayOfWeek"> & { dayOfMonth?: number | null; dayOfWeek?: number | null }): Schedule` — DAILY: both null. WEEKLY: `dayOfWeek` kept or the start date's weekday, `dayOfMonth` null. MONTHLY, QUARTERLY, YEARLY: `dayOfMonth` kept or the start date's day, `dayOfWeek` null.
  - `scheduleViolations(schedule: Schedule): { field: "interval" | "dayOfMonth" | "dayOfWeek" | "endDate" | "occurrenceLimit"; message: string }[]` — interval 1 to `INTERVAL_MAX`; `dayOfWeek` 1 to 7 for WEEKLY; `dayOfMonth` 1 to 31 where used; `endDate` not before `startDate`; limit 1 to `OCCURRENCE_LIMIT_MAX`. Messages are user-facing.
  - `datesDue(schedule: Schedule, opts: { from: CalendarDate; count: number; upTo?: CalendarDate; max: number }): CalendarDate[]` — the scheduled dates on or after `from` (and never before `startDate`), up to `upTo` inclusive when given, never past `endDate`, stopping when `count + produced` reaches `occurrenceLimit`, at most `max`. `count` is how many occurrences the rule already has (every status).
  - `firstDue(schedule: Schedule, count?: number): CalendarDate | null` = the first of `datesDue` from `startDate`.

- [ ] **Step 1: Write the failing tests.** In `calendar-date.test.ts`: `isoWeekday("2026-10-28")` is 3 (Wednesday), `"2026-11-02"` is 1, `"2026-11-01"` is 7. In `recurrence.test.ts` (each is `datesDue` with a large `max` and `upTo` unless stated):
  - MONTHLY day 31 from `2026-01-31`: `2026-01-31, 2026-02-28, 2026-03-31, 2026-04-30, 2026-05-31` (no drift: March is the 31st). From `2028-01-31`: `2028-02-29` then `2028-03-31`.
  - MONTHLY day 5 from `2026-01-20`: first date `2026-02-05` (the grid date before the start is skipped).
  - QUARTERLY day 15 from `2026-01-15`: `01-15, 04-15, 07-15, 10-15`; interval 2: `2026-01-15, 2026-07-15, 2027-01-15`.
  - YEARLY day 29 from `2024-02-29`: `2024-02-29, 2025-02-28, 2026-02-28, 2027-02-28, 2028-02-29`.
  - WEEKLY day 1 from `2026-10-28` (a Wednesday): `2026-11-02, 2026-11-09`; interval 2: `2026-11-02, 2026-11-16, 2026-11-30`.
  - DAILY interval 3 from `2026-12-30`: `2026-12-30, 2027-01-02, 2027-01-05`.
  - DST (EC-41): DAILY from `2026-03-06` to `2026-03-10` and from `2026-10-30` to `2026-11-03` give five consecutive days each, none skipped or doubled.
  - `endDate` is inclusive: MONTHLY day 31 from `2026-01-31`, end `2026-03-31`, gives three dates. A start after the end gives none.
  - Limit: limit 2 with `count: 0` gives two dates, with `count: 1` gives one, with `count: 2` none.
  - `from` is inclusive and never reaches before `startDate`: day-31 rule, `from: "2026-03-01"` gives `2026-03-31` first; `from` before the start gives the same as the start.
  - `max: 3` truncates; `upTo` truncates; no `upTo` and no end terminates at `max`.
  - `firstDue` and `normaliseSchedule` defaults (weekly from a Wednesday gets `dayOfWeek` 3; yearly from `2024-02-29` gets `dayOfMonth` 29); `scheduleViolations` for each field.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh src/domain/recurrence.test.ts src/domain/calendar-date.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files. Approach: the nth grid date is a function of the anchor and `n` (months from the start month times the step, clamped to the month's length), never derived from the previous date. Walk `n` upward from the first index whose date is on or after `startDate`. For WEEKLY the grid anchor is the first date on or after `startDate` with the weekday.
- [ ] **Step 4: Run to verify it passes** in both zones (same command).
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(domain): recurrence schedule, clamped month ends, no drift`.

---

### Task 3: Schema, migration, cleanup

**Files:**
- Modify: `prisma/schema.prisma`; `tests/db/schema.test.ts`, `tests/db/enum-parity.test.ts`, `tests/server/repositories/fixtures.ts`, `tests/e2e/fixtures.ts` (cleanup order)
- Create: `prisma/migrations/20261028000000_recurring_rules/migration.sql`

**Interfaces:**
- Produces: Prisma models and enums exactly as design §5, with these additions: `RecurringRule.idempotencyKey String?` and `@@unique([userId, idempotencyKey])`; `User.recurringRules` and `User.recurringOccurrences` relations; `LedgerNode` back-relations (`recurringFrom`, `recurringTo`); `Transaction.occurrence RecurringOccurrence?`. Enums `RecurrenceFrequency` (same members as `RECURRENCE_FREQUENCIES`) and `OccurrenceStatus { PENDING POSTED DISMISSED }`. Indexes: `RecurringRule @@index([userId, nextDueOn])`; `RecurringOccurrence @@unique([ruleId, dueOn])`, `@@index([userId, status, dueOn])`.
- CHECK constraints in the migration SQL: `interval >= 1`, `dayOfMonth` null or 1 to 31, `dayOfWeek` null or 1 to 7, `amountPaise > 0`, `occurrenceLimit` null or `>= 1`.
- Cleanup order everywhere users are deleted: `recurringOccurrence`, then `recurringRule`, before `transaction` and `ledgerNode` (foreign keys are RESTRICT).

- [ ] **Step 1: Write the failing tests.** `enum-parity.test.ts`: `RecurrenceFrequency` has exactly the domain's `RECURRENCE_FREQUENCIES`. `schema.test.ts` (follow its existing constraint tests): inserting a rule with `interval 0`, `dayOfMonth 32`, `dayOfWeek 8`, `amountPaise 0` or `occurrenceLimit 0` is rejected by the database; a second occurrence with the same `(ruleId, dueOn)` is rejected; two rules with the same `(userId, idempotencyKey)` are rejected while any number with a null key coexist; an occurrence's `transactionId` is unique.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh tests/db`. Expected: FAIL (models missing).
- [ ] **Step 3: Edit `schema.prisma`, run `bunx prisma migrate dev --create-only --name recurring_rules`,** append the CHECK constraints to the generated SQL, then `bunx prisma migrate dev` to apply and `bunx prisma generate`. Update the three cleanup sites. Confirm the test database applies it (`tests/db/global-setup.ts`).
- [ ] **Step 4: Run to verify it passes.** `sh scripts/test-tz.sh tests/db`. Expected: PASS.
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(db): recurring rules and occurrences, with constraints`.

---

### Task 4: Repository

**Files:**
- Create: `src/server/repositories/recurring-repository.ts`, `tests/server/repositories/recurring.test.ts`
- Modify: `src/server/repositories/errors.ts` (`NotFoundError` entity gains `"rule" | "occurrence"`), `tests/server/repositories/fixtures.ts` (`makeRule`, `makeOccurrence` helpers), `tests/server/repositories/isolation.test.ts`

**Interfaces:**
- Consumes: `assertNodesOwned`, `Db`, `UnitOfWork`/`clientOf`, `toDbDate`/`fromDbDate`, `NotFoundError`.
- Produces (all take `userId` first; `uow?` last where a caller may be inside a transaction):
  - `interface RuleData { name: string; fromNodeId: string; toNodeId: string; amountPaise: Paise; note: string | null; tags: string[]; frequency: RecurrenceFrequency; interval: number; dayOfMonth: number | null; dayOfWeek: number | null; startDate: CalendarDate; endDate: CalendarDate | null; occurrenceLimit: number | null; autoPost: boolean }`
  - `insertRule(userId, data: RuleData & { nextDueOn: CalendarDate | null; idempotencyKey?: string | null }, uow?): Promise<RecurringRule>` — checks both nodes are the user's; a repeated key throws `DuplicateRuleKeyError(existing)` (new class in this file).
  - `findRuleById(userId, id, uow?): Promise<RecurringRule | null>` (live only), `findRules(userId): Promise<RecurringRule[]>` (live; next due soonest first, finished last, then name).
  - `updateRule(userId, id, expectedVersion: number, changes: Partial<RuleData> & { nextDueOn?: CalendarDate | null; pausedAt?: Date | null }, uow?): Promise<RecurringRule>` — bumps `version`; a stale version throws `RuleVersionConflictError(current)`; unknown or foreign id throws `NotFoundError("rule")`; changed node ids are ownership-checked.
  - `softDeleteRule(userId, id, uow: UnitOfWork): Promise<void>` — sets `deletedAt` and deletes the rule's PENDING occurrences.
  - `lockRule(userId, id, uow: UnitOfWork): Promise<RecurringRule | null>` — `SELECT … FOR UPDATE` of a live rule.
  - `findDueRules(userId, through: CalendarDate, uow?): Promise<RecurringRule[]>` — live, not paused, `nextDueOn <= through`.
  - `findUsersWithRulesDueBy(through: CalendarDate): Promise<string[]>` — distinct user ids; the one query that is not scoped to a user, used only by the sweep (a comment says so).
  - `insertOccurrences(userId, ruleId, dueOns: CalendarDate[], uow: UnitOfWork): Promise<RecurringOccurrence[]>` — `ON CONFLICT (ruleId, dueOn) DO NOTHING`; returns only the rows actually inserted; rule must be the user's.
  - `countOccurrences(userId, ruleId, uow?): Promise<number>`
  - `type OccurrenceWithRule = RecurringOccurrence & { rule: RecurringRule }`; `findOccurrenceById(userId, id, uow?): Promise<OccurrenceWithRule | null>`; `findPending(userId): Promise<OccurrenceWithRule[]>` (oldest due first, live rules); `countPending(userId): Promise<number>`; `findRecentlyHandled(userId, limit: number): Promise<OccurrenceWithRule[]>` (POSTED and DISMISSED, newest `resolvedAt` first).
  - `markPosted(userId, id, transactionId: string): Promise<RecurringOccurrence | null>` and `markDismissed(userId, id)` and `markPending(userId, id)` (put back): each is one conditional update (`WHERE status = <expected>`); `null` means it was not in the expected state. `markPosted` clears `postFailure` and sets `resolvedAt`.
  - `setPostFailure(userId, id, text: string | null): Promise<void>` (only while PENDING).

- [ ] **Step 1: Write the failing tests** in `recurring.test.ts` against the real database: insert and read back (paise as bigint, dates as `CalendarDate`); `insertRule` with a foreign user's node id throws `NotFoundError`; the duplicate key throws `DuplicateRuleKeyError` carrying the stored row; `updateRule` with a stale version throws `RuleVersionConflictError` and leaves the row; `softDeleteRule` hides the rule from `findRuleById`/`findRules` and removes only its PENDING occurrences (a POSTED and a DISMISSED one remain); `lockRule` returns null for a deleted rule; `findDueRules` honours `through`, pause and deletion; `insertOccurrences` called twice with overlapping dates returns only the new ones the second time and never duplicates; `markPosted` twice: the second returns `null`; `markDismissed` then `markPending` round-trips; `findPending` excludes a deleted rule's. **Isolation:** in `isolation.test.ts`, every function above called with a foreign user's rule or occurrence id behaves as not-found (null, `NotFoundError`, or an empty list), using the exact-leak style of the existing cases.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh tests/server/repositories/recurring.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the repository. `insertOccurrences` and `lockRule` use `$queryRaw` through `clientOf(uow)`; everything else is Prisma. Follow `transaction-repository.ts` for the `userId`-in-every-`where` convention and the header comment.
- [ ] **Step 4: Run to verify it passes** (same command, plus `isolation.test.ts`).
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(recurring): repository with user-scoped queries and a duplicate-proof insert`.

---

### Task 5: Post, skip, put back (occurrence service)

**Files:**
- Create: `src/server/services/occurrence-service.ts`, `src/lib/recurring-view.ts` (`OccurrenceView`, `toOccurrenceView`), `tests/server/recurring/occurrences.test.ts`

**Interfaces:**
- Consumes: Task 4 repository; `recordTransaction`, `InvalidTransactionError`, `OverdraftBlockedError` from `transaction-service`; `lotModeOf`; `toPickerNode`.
- Produces:
  - `interface OccurrenceView { id: string; ruleId: string; ruleName: string; dueOn: string; status: "PENDING" | "POSTED" | "DISMISSED"; fromNodeId: string; toNodeId: string; fromName: string; toName: string; amountPaise: string; note: string | null; tags: string[]; postFailure: string | null; needsQuantity: boolean; unitLabel: string | null; nodeArchived: boolean; transactionId: string | null }` — `needsQuantity` is true when the destination is an investment valued by `QUANTITY`; `nodeArchived` when either end is archived.
  - `postOccurrence(userId: string, id: string, overrides?: { amount?: Paise; occurredAt?: CalendarDate; note?: string | null; quantity?: Quantity }): Promise<OccurrenceView>` — records the rule's template (overrides applied; `occurredAt` defaults to `dueOn`) with key `recurring:<id>`, then `markPosted`. Already POSTED returns the posted view (a replay). DISMISSED throws `OccurrenceStateError("Put it back before posting it.")`. A `null` from `markPosted` re-reads and returns the posted view. Unknown, foreign or deleted-rule id throws `NotFoundError`.
  - `dismissOccurrence(userId, id): Promise<OccurrenceView>` — PENDING to DISMISSED; already DISMISSED returns it; POSTED throws `OccurrenceStateError`.
  - `restoreOccurrence(userId, id): Promise<OccurrenceView>` — DISMISSED to PENDING; PENDING returns it; POSTED throws.
  - `class OccurrenceStateError extends Error`.

- [ ] **Step 1: Write the failing tests** (rows created through the repository helpers, not through generation):
  - Post as proposed: the transaction has the rule's nodes, amount, tags and note, `occurredAt = dueOn`; the occurrence is POSTED with its `transactionId`; the balances moved by exactly the amount.
  - Post with overrides: the typed amount, date and note are what is stored (`recordTransaction` reads them back).
  - EC-47 honesty: with three PENDING occurrences present, `sumBalances` and `getDashboard` net worth equal their values before the occurrences existed; after one post they differ by exactly that amount.
  - Double post in sequence and in `Promise.all` (two calls): exactly one transaction exists, both calls return the same `transactionId`.
  - Skip then post throws `OccurrenceStateError`; skip then put back then post works; skipping a POSTED one throws.
  - A rule into a `QUANTITY` investment: posting without a quantity fails with the existing quantity violation; with one it posts and creates the lot; `needsQuantity` is true in the view.
  - Overdraft: a `blockNegative` source with too little money makes posting throw `OverdraftBlockedError` and leaves the occurrence PENDING.
  - A node archived after generation: skipping works; posting throws `InvalidTransactionError` (archived), the occurrence stays PENDING; `nodeArchived` is true.
  - Foreign user's id: `NotFoundError` for all three functions. After `softDeleteRule`, posting its (removed) occurrence throws `NotFoundError`.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh tests/server/recurring/occurrences.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the service and the view builder. `toOccurrenceView(occurrence, rule, fromNode, toNode)` is pure and lives in `src/lib`; the service loads the two nodes with `requireNode`-style ownership.
- [ ] **Step 4: Run to verify it passes.** Same command, both zones.
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(recurring): post, skip and put back an occurrence, exactly once`.

---

### Task 6: Generation, the sweep and the sign-in trigger

**Files:**
- Create: `src/server/services/recurring-generation.ts`, `tests/server/recurring/generation.test.ts`
- Modify: `src/instrumentation.ts` (replace the stub run with `sweepAll`), `src/server/auth.ts` (`events.signIn`)

**Interfaces:**
- Consumes: Task 4 repository, Task 5 `postOccurrence`, Task 2 `datesDue`/`MAX_DUE_PER_RUN`, `todayFor`, `inTransaction`.
- Produces:
  - `generateDue(userId: string): Promise<{ created: number; posted: number }>` — for every rule from `findDueRules(userId, today)` whose two nodes are not archived: in one transaction `lockRule`, re-check `nextDueOn <= today`, `datesDue(schedule, { from: nextDueOn, count: await countOccurrences(...), upTo: today, max: MAX_DUE_PER_RUN })`, `insertOccurrences`, then set `nextDueOn` to the next date (`datesDue` from the day after the last generated, `max: 1`) or `null`. After commit, for an `autoPost` rule post each newly inserted occurrence with `postOccurrence`; on a throw leave it PENDING and `setPostFailure` with the error's message (an unknown error gets "It could not be posted automatically." and is logged). A rule touching an archived node is skipped untouched.
  - `sweepAll(): Promise<void>` — `findUsersWithRulesDueBy(UTC today + 1 day)`, then `generateDue` per user sequentially; one user's failure is logged and does not stop the rest.
  - `generateInBackground(userId: string): void` — calls `generateDue`, swallows and logs any error, returns immediately.
  - `src/server/auth.ts`: `events: { signIn: ({ user }) => { if (user.id) generateInBackground(user.id) } }`.
  - `src/instrumentation.ts` now starts `startSweepTimer({ run: sweepAll })`.

- [ ] **Step 1: Write the failing tests** (real database; `sumBalances`, `getDashboard` for honesty):
  - Weekly rule whose `nextDueOn` is three weeks before the user's today: three PENDING occurrences with the right dates, `nextDueOn` is now the first date after today; a second `generateDue` creates nothing.
  - Cap and continuation: a daily rule due 250 days ago: three successive runs create 100, 100 and 50, every date present once, none missing, the fourth run creates nothing.
  - Month-end: a monthly day-31 rule due from `2026-01-31` with today `2026-05-01` yields Jan 31, Feb 28, Mar 31, Apr 30 (use a user whose today is controlled; see the clock helper pattern in existing `balance-service` tests).
  - Limit and end date: a rule with `occurrenceLimit 2` stops after two and `nextDueOn` is `null`; an `endDate` before the next date does the same.
  - Concurrency: `Promise.all([generateDue(u), generateDue(u), generateDue(u)])` leaves exactly one set of occurrences and a correct `nextDueOn`.
  - **Review focus 1:** two users, one in `Pacific/Kiritimati` (a day ahead of UTC) and one in `Pacific/Pago_Pago` (a day behind), each with a rule due on the UTC date's neighbour: only the rule whose date is ≤ that user's own today generates.
  - Archived node (**review focus 3**): archiving the destination makes `generateDue` create nothing and leave `nextDueOn`; un-archiving and running again catches up every missed date.
  - Paused rule generates nothing; a deleted rule generates nothing.
  - Auto-post: an `autoPost` rule posts each new occurrence (transactions exist, status POSTED, key `recurring:<id>`); running again posts nothing more; with an overdraft block the occurrence stays PENDING with `postFailure` set to the service's message; a transient unknown error (stub `recordTransaction` to throw once) leaves PENDING with the generic text.
  - EC-47 across the reports: with pending occurrences generated, `getDashboard` net worth and `loadCashFlow` for the month equal their pre-generation values.
  - `sweepAll` over two users with one failing user: the other is generated and the error is logged. `generateInBackground` with a throwing `generateDue` does not throw.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh tests/server/recurring/generation.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the service, the `events.signIn` hook and the `instrumentation.ts` change. The coarse sweep bound is UTC today plus one day: that covers every zone up to UTC+14.
- [ ] **Step 4: Run to verify it passes**, both zones.
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(recurring): catch-up generation, hourly sweep and sign-in trigger`.

---

### Task 7: Rule lifecycle (service and schemas)

**Files:**
- Create: `src/server/services/recurring-service.ts`, `src/lib/schemas/recurring.ts`, `tests/server/recurring/rules.test.ts`, `tests/server/recurring/schemas.test.ts`
- Modify: `src/lib/schemas/transaction.ts` (export `tags` as `tagsField`), `src/lib/recurring-view.ts` (add `RuleView`, `toRuleView`), `src/lib/recurring-text.ts` (create: `describeSchedule(schedule): string`, `nextDatesPreview(schedule, count, n): CalendarDate[]`)

**Interfaces:**
- Consumes: Tasks 2, 4, 6; `validateTransaction`, `requireNode`, `lotModeOf`, `cleanNote`, `cleanTags`.
- Produces:
  - `RuleInput { name: string; fromNodeId: string; toNodeId: string; amount: Paise; note?: string; tags?: string[]; frequency: RecurrenceFrequency; interval: number; dayOfMonth?: number; dayOfWeek?: number; startDate: CalendarDate; endDate?: CalendarDate; occurrenceLimit?: number; autoPost: boolean }`.
  - `class InvalidRuleError extends Error { violations: { field: string; message: string }[] }`.
  - `createRule(userId, input: RuleInput & { idempotencyKey: string }): Promise<RuleView>` — validates the template with `validateTransaction` (violations filed under `fromNodeId`, `toNodeId`, `amount`), the schedule with `normaliseSchedule` and `scheduleViolations`, refuses `autoPost` into a `QUANTITY` investment (field `autoPost`), refuses a start date that would make more than `MAX_DUE_PER_RUN` occurrences due now (field `startDate`, "choose a later start date"), inserts with `nextDueOn = firstDue(...)`, then calls `generateDue(userId)` so the inbox is current. A replayed key returns the stored rule.
  - `editRule(userId, id, expectedVersion: number, input: Omit<RuleInput, "startDate"> & { nextDue: CalendarDate }): Promise<RuleView>` — the same validation; **re-anchors**: `startDate := nextDue`, `nextDueOn := firstDue(schedule, count)`. A stale version throws `RuleVersionConflictError`. Existing occurrences and posted transactions are untouched. Calls `generateDue` after.
  - `setPaused(userId, id, paused: boolean): Promise<RuleView>` — pause sets `pausedAt`; resume clears it and sets `nextDueOn` to the first scheduled date **after today** (no backfill), then `generateDue`.
  - `deleteRule(userId, id): Promise<void>` — in one transaction (`softDeleteRule`).
  - `RuleView { id; name; fromNodeId; toNodeId; fromName; toName; amountPaise: string; note; tags; frequency; interval; dayOfMonth; dayOfWeek; startDate; endDate; occurrenceLimit; autoPost; nextDueOn: string | null; state: "active" | "paused" | "finished" | "blocked"; scheduleText: string; version: number }` — `blocked` when an end node is archived; `finished` when `nextDueOn` is null.
  - `src/lib/schemas/recurring.ts`: `createRuleSchema` (strict; rupee text `amount` via `positiveRupees`; `name` trimmed 1 to 60; `startDate`, `endDate` via `occurredAtField`; `interval` integer; `idempotencyKey` via `idempotencyKeyField`), `editRuleSchema` (`{ id, expectedVersion, rule }` with `nextDue` in place of `startDate`), `ruleIdSchema`, `pauseRuleSchema`.
  - `describeSchedule` examples: `Monthly on the 31st, or the last day`, `Every 2 weeks on Monday`, `Every 3 months on the 15th`, `Yearly on 29 February (28 February in other years)`, `Every day`.

- [ ] **Step 1: Write the failing tests.** `rules.test.ts`: create then the inbox is immediate (a rule starting 10 days ago, weekly, makes 2 pending at once and `nextDueOn` is in the future); `autoPost` into a `QUANTITY` investment is refused under `autoPost`, into a `LUMP` investment allowed; an illegal flow, same node and an archived end each refused under the right field; a start date 400 days back on a daily rule is refused with the 100 limit message; a repeated key returns the same rule, one row; edit with a stale version conflicts; **edit leaves posted transactions untouched and does not change existing pending `dueOn`s**; **review focus 2:** a yearly day-29 rule created from `2024-02-29`, edited with `nextDue: "2026-02-28"` and `dayOfMonth: 29` unchanged, still yields `2028-02-29` after `2027-02-28`; a schedule edit from every 2 months to every 3 starts at the chosen `nextDue`; pause stops generation; **review focus 5:** resume after a long pause creates nothing for the paused months and the first new date is after today; delete removes pending, keeps POSTED and DISMISSED rows, leaves the posted transactions, and the rule is gone from `findRules`. `schemas.test.ts`: unknown keys refused (`userId`, `version`, `nextDueOn`), blank name, 61-character name, bad dates, `interval: 0`, rupee text parsing, the key length floor. `recurring-text` tests for the five `describeSchedule` strings above and `nextDatesPreview`.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh tests/server/recurring/rules.test.ts tests/server/recurring/schemas.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the service, schemas, view and text helpers. The previews and `describeSchedule` are pure and import only domain and lib code, so the client form (Task 10) can use them.
- [ ] **Step 4: Run to verify it passes**, both zones.
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(recurring): create, edit, pause and delete a rule`.

---

### Task 8: Screen loader and Server Actions

**Files:**
- Create: `src/app/recurring/actions.ts`, `src/app/recurring/recurring-failure.ts`, `tests/server/recurring/actions.test.ts`
- Modify: `src/server/services/recurring-service.ts` (add `loadRecurringScreen`, `countPendingFor`, `loadRuleForEdit`, `templateFromTransaction`), `src/server/action-support.ts` (`wrote()` also revalidates `/recurring`)

**Interfaces:**
- Produces:
  - `loadRecurringScreen(userId): Promise<{ inbox: OccurrenceView[]; rules: RuleView[]; recent: OccurrenceView[]; nodes: PickerNode[]; today: CalendarDate }>` — `recent` is the last 20 handled.
  - `countPendingFor(userId): Promise<number>`.
  - `loadRuleForEdit(userId, id): Promise<{ rule: RuleView; nodes: PickerNode[]; today: CalendarDate }>` (`NotFoundError` if not the user's).
  - `templateFromTransaction(userId, transactionId): Promise<{ draft: RuleDraft; nodes: PickerNode[]; today: CalendarDate }>` where `RuleDraft` is the form's initial values: nodes, amount (paise text), note, tags, `frequency "MONTHLY"`, `interval 1`, `startDate` = the same day-of-month in the month after the transaction's date (clamped), `autoPost false`; refuses a transaction in a split group or touching a system node with `NotFoundError`.
  - Actions (each calls `requireUserId()` first, parses `unknown` input with Zod, returns `ActionResult`, calls `wrote()` after a write): `createRuleAction`, `editRuleAction`, `pauseRuleAction`, `resumeRuleAction`, `deleteRuleAction`, `postOccurrenceAction({ id, amount?, occurredAt?, note?, quantity? })`, `dismissOccurrenceAction({ id })`, `restoreOccurrenceAction({ id })`. Failure mapping in `recurring-failure.ts`: `InvalidRuleError` to `invalid` with field errors; `RuleVersionConflictError` to `version_conflict` (message only; the form reloads); `OccurrenceStateError` to `invalid`; `NotFoundError` to `not_found` with "This entry no longer exists. It may have been handled or its rule deleted in another tab." (**review focus 4**); `InvalidTransactionError` and `OverdraftBlockedError` as the transaction actions map them (reuse their violation-to-field table for `amount`, `quantity`, `toNodeId`).

- [ ] **Step 1: Write the failing tests** in `actions.test.ts`, shaped like `tests/server/transaction-actions.test.ts`: a lapsed session redirects to `/login`; bad input returns `invalid_input` with field errors and writes nothing; each action returns plain data (no bigint, no Date: serialise it with `JSON.stringify`); a foreign user's id is `not_found`; posting after the rule was deleted returns `not_found` with the message above; posting twice returns `ok` both times with one transaction; `loadRecurringScreen` lists a deleted rule's nothing, orders the inbox oldest first; `countPendingFor` counts only live pending; `templateFromTransaction` of a split leg is `NotFoundError`.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh tests/server/recurring/actions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the loader functions and the actions.
- [ ] **Step 4: Run to verify it passes**, both zones.
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(recurring): screen loader and Server Actions`.

---

### Task 9: The Recurring screen (inbox, rules, nav badge, dashboard notice)

**Files:**
- Create: `src/app/recurring/page.tsx`, `loading.tsx`, `inbox.tsx`, `inbox-card.tsx`, `rules-list.tsx`, `recent-list.tsx`, `src/app/pending-notice.tsx`, `tests/server/recurring-render.test.ts`
- Modify: `src/app/app-nav.tsx` (new `"recurring"` destination, `Repeat` icon from lucide), `src/app/app-shell.tsx` (reads `countPendingFor` and passes `pending`), `src/components/ui/sidebar.tsx` (`NavItem.badge?: number`), `src/app/page.tsx` (render `PendingNotice` when the count is above zero)

**Interfaces:**
- Consumes: Task 8 loaders and actions; existing `Amount`, `SpotlightCard`, `buttonClass`, `Collapse`, `notice-toast` patterns.
- Produces: the `/recurring` page (`AppShell current="recurring"`) with the layout of design §9: **Inbox** (oldest first; each card shows rule name, due date, from to, amount, the `postFailure` note when set, and the actions **Post** (one tap, as proposed), **Edit and post** (amount, date, note, and quantity when `needsQuantity`), **Skip**); **Rules** (schedule in words, next due, state chip for paused, finished and blocked-by-archived-node with the reason, with Edit, Pause or Resume, Delete behind a confirm); **Recently handled** as a disclosure with **Put back** on skipped ones and "entry deleted" is not shown (parked). `PendingNotice` is one line, "3 entries waiting", linking to `/recurring`. The nav badge shows the pending count and is announced ("Recurring, 3 waiting").
- A card whose `needsQuantity` is true opens Edit and post directly when Post is pressed, with the quantity field focused. A card with `nodeArchived` disables Post and says why, leaving Skip enabled.

- [ ] **Step 1: Write the failing render tests** (server-render the components, as `reports-render.test.ts` does): an inbox card shows the failure note; a `needsQuantity` card has no one-tap Post; a `nodeArchived` card has Post disabled and Skip enabled; an empty inbox says what a rule is for and links to New rule; the rules list shows the schedule text and a "Paused" chip; the nav item carries the badge text and an accessible name; the dashboard renders `PendingNotice` only for a count above zero; no amount renders as a number type (all paise text through `Amount`).
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh tests/server/recurring-render.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the page and components. The page reads only; the actions are the client's buttons (`useTransition`, `router.refresh` through `wrote()`), announcing success and failure through the existing notice pattern. Palette tokens only; focus rings not clipped (the M3 fix: padding with negative margin on scrollers).
- [ ] **Step 4: Run to verify it passes**, both zones. Then open `/recurring` in the running app in light and dark at desktop and 375px width and confirm no horizontal scroll; note anything odd in the rulings file.
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(recurring): the inbox and rules screen, nav badge and dashboard notice`.

---

### Task 10: The rule form and "Make recurring"

**Files:**
- Create: `src/app/recurring/new/page.tsx`, `src/app/recurring/[id]/edit/page.tsx`, `src/app/recurring/rule-form.tsx`, `tests/server/recurring-form-render.test.ts`, `src/app/recurring/rule-fields.test.ts`
- Modify: `src/app/transactions/transaction-row.tsx` (a "Make recurring" link for a single, non-split, non-system entry to `/recurring/new?from=<id>`)

**Interfaces:**
- Consumes: Task 7 schemas and `describeSchedule`/`nextDatesPreview`; Task 8 actions and loaders; `destinationChoices`/`sourceChoices` from `src/app/transactions/pickers.ts`; `newRequestKey`.
- Produces: one client form for create and edit. Fields: name, source, destination (narrowed by flow legality as the transaction form does), amount (rupee text), frequency, interval, day of month or day of week (shown only where used; the day-of-month control says "31, or the last day if the month is shorter"), **Starts on** when creating or **Next due on** when editing, optional end date, optional limit, note, tags, **Post automatically** (hidden for a `QUANTITY` investment destination, with the reason). A live line shows the next three dates from `nextDatesPreview`, and, when the start is in the past, "N entries will appear in your inbox now". The request key is chosen once and kept across attempts (as the transaction form does); edit sends `expectedVersion`; a version conflict reloads with a notice. On success it goes to `/recurring`. `/recurring/new?from=<transactionId>` prefills from `templateFromTransaction`.

- [ ] **Step 1: Write the failing tests.** `rule-fields.test.ts` (pure helpers extracted from the form: which of day-of-month, day-of-week are shown per frequency; whether Post automatically is offered for a destination; the "N entries now" count from `datesDue` through today, capped display at "more than 100"). `recurring-form-render.test.ts`: the form for MONTHLY shows day of month and not day of week; for WEEKLY the reverse; the 31st helper text is present; the preview line shows three dates for a known schedule; the "Make recurring" link renders on a single entry and not on a split leg or a system-node entry; a prefilled form carries the transaction's nodes and amount.
- [ ] **Step 2: Run to verify it fails.** `sh scripts/test-tz.sh src/app/recurring tests/server/recurring-form-render.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the form, the two pages and the row link. The preview and "now" count import the pure domain and lib modules directly in the client component.
- [ ] **Step 4: Run to verify it passes**, both zones. Then create a rule, edit it and delete it by hand in the browser at desktop and 375px.
- [ ] **Step 5: `bun run test` and `bun run lint`, then commit** `feat(recurring): rule form with a live schedule preview, and make-recurring from a transaction`.

---

### Task 11: End to end, isolation, documentation

**Files:**
- Create: `tests/e2e/recurring.spec.ts`
- Modify: `tests/e2e/seed.ts` (`recurringRule(userId, opts)`, a thin wrapper over `createRule`), `tests/e2e/isolation.spec.ts`, `README.md` (a "Recurring entries" section: what a rule is, that nothing posts until confirmed, the sweep and its two env variables, the fallback route if Task 1 needed it), `docs/superpowers/specs/2026-10-28-accufi-m4-recurring-design.md` (status line: approved, amended at planning for the rule idempotency key, built), `docs/superpowers/specs/2026-09-11-accufi-design.md` (status line on §8.4), `docs/superpowers/decisions/2026-10-28-m4-rulings.md` ("Known and parked": deleting the transaction behind a POSTED occurrence leaves it POSTED; no bulk post; no "from rule" chip in the list; split templates; anything the reviews parked)

**Interfaces:** consumes everything above. Produces the exit-criterion proof and the isolation proof.

- [ ] **Step 1: Write the e2e specs** (each test gets its own user from the existing fixtures; seed through services, call `generateDue(userId)` after seeding because the sweep is off in e2e):
  - **Exit criterion, catch-up:** a weekly rule three weeks behind: the inbox shows three cards oldest first and the nav badge says 3; Post one: it leaves the inbox, the transaction appears in `/transactions` and the account balance changes by exactly the amount; the other two still do not count anywhere (dashboard net worth moved by one amount only).
  - **Exit criterion, month end:** a monthly day-31 rule due from 31 January through the following 30 April: the inbox cards are dated 31 Jan, 28 Feb, 31 Mar, 30 Apr (assert the visible dates).
  - **Edit and post:** change amount and date on a card; the transaction carries them. **Skip then Put back** from Recently handled.
  - **Create from the form:** fill the new-rule form, see the preview line, submit, find the rule listed with its schedule in words and the right next due. **Make recurring** from a transaction row prefills the form.
  - **Sign-in generates:** seed a rule due in the past, sign out, sign in through the form: the inbox has the entry without any other action.
  - **Quantity SIP:** a rule into a quantity-valued investment: Post opens the form with Quantity focused; Post automatically is not offered.
  - **Dark theme and reduced motion** render the screen (follow `theme.spec.ts`); the whole inbox is reachable and operable by keyboard.
  - **Isolation** (extend `isolation.spec.ts` with the Zephyr pattern): user A's rule name and amount never appear in B's `/recurring`, B's nav badge, or B's page HTML; B visiting `/recurring/<A rule id>/edit` gets not-found; B's Post, Skip and Delete actions on A's ids return not-found and change nothing for A.
- [ ] **Step 2: Run to verify they fail.** `bunx playwright test tests/e2e/recurring.spec.ts tests/e2e/isolation.spec.ts`. Expected: FAIL (before the seed helper exists, then on any gap found).
- [ ] **Step 3: Add the seed helper, fix any defect the specs expose** (each fix gets a regression test at the lowest layer that shows it), and write the documentation changes above.
- [ ] **Step 4: Run the whole gate.** `bun run test`, `bun run lint`, then `bunx playwright test` (the known `transactions.spec.ts` flake under parallel load passes alone). Expected: all green; report the counts.
- [ ] **Step 5: Commit** `test(recurring): end-to-end and isolation proof, docs`.
