# AccuFi M4 — Recurring entries: design

**Status:** Approved, amended at planning (the rule idempotency key; the generation and edit details recorded in `docs/superpowers/decisions/2026-10-28-m4-rulings.md`), built on branch `feat/m4-recurring`. **Date:** 2026-10-28. **Builds on:** `2026-09-11-accufi-design.md` §8.4 (recurring entries), §6.4, §4.2, EC-40/41/42/43/44/45/47, decision-log row "Recurring proposes rather than posts". M0–M3 are merged and pushed.

The user asked for the design to be drafted straight from the spec, without a question round. Everything the spec leaves open is decided here and listed in **Calls I made** at the end, each with what it costs if wrong. CSV import (and EC-46, matching imports to pending occurrences) is **M6**, not here; the spec's M4 row is recurring rules and the inbox only.

## 1. Intent

Most of a month's ledger repeats: rent, salary, SIPs, subscriptions, the card-bill payment. Entering them by hand every month is the chore that makes people stop keeping a ledger. M4 lets the user describe a repeating entry once. AccuFi then **proposes** each occurrence when it falls due, and the user confirms, edits, or skips it.

The organising rule comes from the spec: **a ledger that invents transactions cannot be trusted.** Real salaries vary and real SIPs fail. So a due rule creates a *pending occurrence* in an inbox. It touches no balance, no net worth and no report until the user confirms it (EC-47). Auto-posting exists, per rule and off by default, for the genuinely fixed cases.

The exit criterion from the spec: **a missed week catches up correctly, and a 31st-of-the-month rule survives February.**

## 2. Goals, non-goals, anti-goals

**Goals**
- A rule is a transaction template (from, to, amount, note, tags) plus a schedule: DAILY / WEEKLY / MONTHLY / QUARTERLY / YEARLY, an interval, a day of month or week, a start date, and an optional end date or occurrence limit.
- Due dates become pending occurrences, caught up after downtime (EC-43) with no duplicates, however many processes generate at once.
- An inbox: **Post** as proposed in one tap, **Edit and post** (amount, date, note, quantity), **Skip**, and **Put back** for a skip made by mistake.
- Calendar arithmetic is exact: a month-end rule clamps without drifting (EC-40), a leap-day rule falls to 28 February (EC-42), and nothing reads an instant (EC-41).
- Confirming goes through `recordTransaction`, so every existing rule applies unchanged: flow legality, archived nodes, overdraft blocking, lot purchases, idempotency, the version column.
- A rule can be started from an existing transaction ("Make recurring"), because the entry just typed is the best template there is.

**Non-goals (M4)**
- Budgets (M5), CSV import and matching pending occurrences to imports (M6).
- Forecasts, "projected balance", or counting pending occurrences in any figure.
- Split templates, including a loan EMI split into principal and interest. A rule is one two-sided transaction. (`GroupKind.EMI` stays unused.)
- RRULE strings or irregular schedules (open question 4 in the spec: the structured schedule is the decision; RRULE is the upgrade path).
- Email, push or any notification. The inbox is the notification.
- Bulk actions ("post all"), a calendar view, per-occurrence templates.
- A "from rule" chip on the Transactions list (the link exists in the table; showing it is a later request).

**Anti-goals (a failure even if every test passes)**
- A pending occurrence that moves any balance, net worth point or report figure.
- Two transactions for one due date, from a double click, two tabs, a retry, or the sweep and a login racing.
- A month-end rule that drifts (31 Jan, 28 Feb, **28 Mar**) or rolls into March.
- A confirm that posts something other than what the card showed.
- Auto-post that fails silently: a failure must leave a visible pending occurrence that says why.
- A sign-in that breaks or slows because generation failed.

## 3. Constraints

- Layering unchanged (§9.2). `src/domain/recurrence.ts` is pure (no Prisma, Next or server imports). A new `recurring-repository.ts` takes `userId` first and scopes every query and join. `recurring-service.ts` orchestrates. `src/lib/schemas/recurring.ts` holds the form schema. `src/app/recurring/**` is Server Components passing plain props (paise as text, days as `CalendarDate`).
- Money is integer paise (`bigint`). Days are `CalendarDate` and `DATE` columns; period maths uses UTC components only, so nothing depends on the process timezone. Both timezone passes (`scripts/test-tz.sh`) must stay green.
- "Today" is the user's today (`todayFor`), never the server's.
- Soft-deleted rows never count. Cross-user isolation is tested per repository method with a foreign user's ids, and the isolation e2e is extended to `/recurring` URLs.
- No new dependency. No cached balance. `nextDueOn` is a schedule cursor, not a figure.
- Palette: Graphite & Azure tokens only (no purple, no yellow).

## 4. The schedule (domain)

A schedule is `{ frequency, interval ≥ 1, dayOfMonth?, dayOfWeek?, startDate, endDate?, occurrenceLimit? }`.

| Frequency | Dates |
|---|---|
| DAILY | every `interval` days from `startDate` |
| WEEKLY | every `interval` weeks on `dayOfWeek` (ISO 1 = Monday … 7 = Sunday) |
| MONTHLY | every `interval` months on `dayOfMonth` |
| QUARTERLY | every `3 × interval` months on `dayOfMonth` |
| YEARLY | every `interval` years, on the month and day of `startDate` |

- **Computed from the anchor, never from the previous result.** The nth date is a function of the start month and `n`, so a February clamp does not carry into March: a rule on the 31st gives 31 Jan, 28 Feb (29 in a leap year), 31 Mar, 30 Apr. A YEARLY rule from 29 Feb gives 28 Feb in non-leap years and 29 Feb again in 2028 (EC-40, EC-42).
- `dayOfMonth` 31 means "the last day", by the clamp. The form says so ("31, or the last day if the month is shorter"). No separate "last day" value.
- The **first** occurrence is the first grid date on or after `startDate` (start 20 Jan, day 5 → 5 Feb). Weekly is the same with the weekday.
- The schedule **ends** when the next date is past `endDate`, or when the rule already has `occurrenceLimit` occurrences (every status counts, so a skipped one still uses up the limit).
- Pure functions, expected shape: `nextDue(schedule, after)`, `datesDue(schedule, after, upTo, max)`, `isFinished(schedule, count)`. All take and return `CalendarDate`.

## 5. Data model

One migration, plus CHECK constraints in the migration's SQL, as the lot migrations did (`interval ≥ 1`, `dayOfMonth` 1–31, `dayOfWeek` 1–7, `amountPaise > 0`).

```
enum RecurrenceFrequency { DAILY WEEKLY MONTHLY QUARTERLY YEARLY }
enum OccurrenceStatus    { PENDING POSTED DISMISSED }

model RecurringRule {
  id, userId, name (1-60 chars)
  fromNodeId, toNodeId, amountPaise, note?, tags[]
  frequency, interval (default 1), dayOfMonth?, dayOfWeek?
  startDate (DATE), endDate? (DATE), occurrenceLimit?
  autoPost   Boolean @default(false)
  nextDueOn  DATE?          // next date to generate; null once the schedule has ended
  pausedAt?  version Int @default(0)
  deletedAt? createdAt updatedAt
  @@index([userId, nextDueOn])        // the due scan
}

model RecurringOccurrence {
  id, userId, ruleId, dueOn (DATE)
  status       OccurrenceStatus @default(PENDING)
  transactionId String? @unique     // the transaction it became
  postFailure   String?             // why an auto-post did not happen
  resolvedAt?  createdAt
  @@unique([ruleId, dueOn])         // the guard against a duplicate
  @@index([userId, status, dueOn])  // the inbox
}
```

`Transaction` gains the back relation only; it has no `ruleId`. A pending occurrence is a separate table, so it cannot reach a balance, net worth or report query by construction (EC-47).

## 6. Generation

`generateDue(userId)`: for each rule that is live, not paused, with `nextDueOn ≤ today` (user's today) and whose two nodes are not archived:

1. In one database transaction, lock the rule row (`FOR UPDATE`, as `lockLotHoldings` does) and re-read `nextDueOn`.
2. Create occurrences for each due date, **at most 100 per rule per run** (EC-43). Insert with `ON CONFLICT (ruleId, dueOn) DO NOTHING`. Set `nextDueOn` to the next date, or null if the schedule has ended.
3. For `autoPost` rules, after commit, post each new occurrence through `recordTransaction` with idempotency key `recurring:<occurrenceId>` and mark it POSTED with its `transactionId`. If posting throws, the occurrence stays PENDING with `postFailure` set to the reason (overdraft block, archived node, and so on).

The cap is per run, so a gap of 250 days on a daily rule resolves over three runs, not by dropping dates. A rule touching an archived node generates nothing and the Rules list says why. When the node is restored, the missed dates catch up like any other downtime.

**When it runs**
- **Hourly sweep, and once at startup**, over every user with a rule due by the coarse UTC date. It is started from a Next `instrumentation.ts` `register()` (Node runtime only, disabled by `RECURRING_SWEEP=off`, which the e2e server sets). This is the "scheduled job" of §8.4. One container, no cron, no new service.
- **After sign-in**, fire and forget, errors logged and swallowed. This is the spec's "opportunistic on login", so an instance that was switched off still catches up the moment the user arrives.
- **Never during a page render.** A Server Component stays read-only; the inbox page, the nav badge and the dashboard notice only count.

Exactly-once is held by the unique `(ruleId, dueOn)` plus the row lock, so the sweep and a login racing produce one occurrence, not two.

## 7. Confirm, skip, put back

- **Post** (as proposed): `recordTransaction` with the rule's current template, `occurredAt = dueOn`, key `recurring:<occurrenceId>`.
- **Edit and post**: the same, with the amount, date, note and quantity the user entered. The posted transaction is what the card showed or what they typed, never a hidden third thing.
- Then, in one conditional update, `status = POSTED`, `transactionId`, `resolvedAt`, only `WHERE status = PENDING`. Two tabs confirming at once both reach the same transaction (the key replays), and only one marks it. The second gets the already-posted result.
- **Skip**: `DISMISSED`. **Put back**: `DISMISSED → PENDING`, allowed from a short "Recently handled" list.
- **Purchases into a quantity-valued investment** (a gold or fund SIP) need a quantity each time, which varies. Such a rule **cannot be auto-post**, and Post opens the edit form with the quantity field focused. A lump-valued investment needs no quantity and can be auto-post.
- A pending occurrence whose node has since been archived can still be skipped. Posting it reports the existing archived-node message.
- **Deleting the transaction** an occurrence became leaves the occurrence POSTED, shown as "entry deleted". It is not revived into the inbox. (Parked, see §12.)

## 8. Editing, pausing, deleting a rule

- **Edit** uses `expectedVersion`, like transactions (EC-18). The template is validated by the existing `validateTransaction` (same node, illegal flow, archived at create, amount).
- **Only future occurrences change (EC-44).** Posted transactions are never touched. Existing PENDING occurrences keep their `dueOn` but read the rule's *current* template when they are posted, which the card shows before the user confirms. Changing the schedule re-anchors it: the form asks for the **next due date** and sets `startDate` to it, so "every 2 months" to "every 3 months" starts where the user says and is not computed from a grid they cannot see.
- **Pause / Resume.** Resume starts from the next date after today. Dates missed while paused are not backfilled, because pausing is a decision, unlike downtime.
- **Delete** is a soft delete. Its PENDING occurrences are removed; POSTED and DISMISSED ones stay as history (EC-45). Posted transactions remain.
- **At creation**, a `startDate` that would make more than 100 occurrences due now is refused ("choose a later start date"). A start date in the past that yields fewer says how many entries will appear in the inbox immediately.

## 9. Screens

- **Recurring** (`/recurring`, a new nav destination with a pending-count badge). Top: **Inbox**, oldest due first, each card showing the rule name, due date, from → to, amount, the failure note if any, and the actions of §7. Below: **Rules**, each with its schedule in words ("Monthly on the 31st, or the last day"), next due, paused/finished/archived-node state, and Edit / Pause / Delete. Empty states say what a rule is for. "Recently handled" is a disclosure.
- **New / edit rule**: a form on the pattern of the transaction form (rupee text, day text, node pickers filtered by flow legality, request key). A live line shows the next three dates so the schedule is visible before it is saved.
- **Make recurring**: an action on a transaction row opens the new-rule form prefilled from it, with the start date set to the next date after the transaction's own.
- **Dashboard**: a one-line notice, only when something is pending ("3 entries waiting"), linking to the inbox. Nothing else on the dashboard changes.
- Keyboard reachable, visible focus, reduced motion respected, light and dark through the existing tokens.

## 10. Testing

- **Domain** (both timezone passes): each frequency; interval above 1; the 31st across Jan to Apr in a leap and a non-leap year with no drift; a leap-day YEARLY rule across 2024 to 2028; first-occurrence alignment; weekly weekday; end date; occurrence limit; the 100-per-run cap and continuation; a range spanning a DST change (EC-41, which holds because only UTC date arithmetic is used).
- **Generation** (real DB): a weekly rule three weeks behind gives three pending dates; 250 days of a daily rule resolves in three runs with no gap and no repeat; two concurrent `generateDue` calls give one set; an archived node blocks and then catches up; pause and resume do not backfill; the user's timezone decides "today" (use two users on opposite sides of the date line).
- **Confirm**: Post as proposed equals the template to the paisa; Edit and post equals what was typed; a double confirm and a two-tab confirm give one transaction; Skip and Put back; a quantity-valued purchase demands a quantity and refuses auto-post; an auto-post that hits an overdraft block stays pending with its reason.
- **Honesty (EC-47)**: with pending occurrences present, balances, net worth, the dashboard and all six reports are unchanged; confirming moves them by exactly the amount.
- **Rule lifecycle**: an edit leaves posted transactions alone and re-anchors the future; a stale `expectedVersion` conflicts; delete removes pending and keeps posted.
- **Isolation**: every new repository method with a foreign user's ids; the isolation e2e covers `/recurring` and the rule and occurrence ids.
- **e2e**: create a rule from the form, see it in the inbox, confirm it, find the transaction and the changed balance; Make recurring from a transaction; the nav badge; skip and put back; keyboard and theme.

## 11. What is left to the builder

The exact SQL shape of the due scan and the lock; the layout of the inbox card and the rules list; the copy for schedules in words and for empty and failure states; how the next-three-dates preview computes on the client without importing server code (the domain module is pure, so it can be shared); and whether the sweep timer is cleared on shutdown.

**Risk to settle early.** The production container runs `bun --bun run start`. Confirm in the first task that `register()` runs there and that the timer stays alive. If it does not, the fallback is already in the design: generation on sign-in plus an explicit `POST` route guarded by a secret that any cron can call. That costs one route and a README line, and nothing else changes.

## 12. Calls I made (change any)

| # | Call | Costs if wrong |
|---|---|---|
| 1 | **Pending occurrences are rows in their own table**, kept after they are resolved (the history and the duplicate guard). | A cleanup job later; small. |
| 2 | **`nextDueOn` is stored on the rule** so the due scan is one indexed query. It is a cursor, not a balance. | Computing it on the fly makes the sweep scan every rule; small. |
| 3 | **Generation never runs during a render.** The sweep (hourly and at startup) and sign-in do it. | Running it in the inbox page also is one line, but it makes a read write. |
| 4 | **Pending occurrences read the rule's current template** when posted, rather than a snapshot taken at generation. | A snapshot column; moderate. It would make "edit the rule" not apply to what is already waiting. |
| 5 | **A schedule edit re-anchors on a user-chosen next due date** instead of keeping the original grid. | The grid-from-start model is simpler to code and surprising to use. |
| 6 | **Pause does not backfill** on resume; downtime and an archived node do. | Treating them the same is simpler; backfill-on-resume floods the inbox after a long pause. |
| 7 | **Quantity-valued investments cannot be auto-post**, and Post opens the edit form. | A SIP into a fund with a fixed unit count is the only loser; rare. |
| 8 | **A start date more than 100 occurrences behind is refused.** | One constant; matches EC-43's cap. |
| 9 | **Deleting the transaction behind a POSTED occurrence does not revive it.** | A revive rule couples this table to transaction delete and restore; revisit if it bites. |
| 10 | **A rule has a required name** (1–60 characters), used on the cards. | Deriving one from the nodes is friendlier and less clear. |
| 11 | **Make recurring from a transaction** is in scope. | Cheap to drop (one link and a prefill). |
| 12 | **Skip has a Put back, and nothing else is undoable.** There are no bulk actions. | Bulk "post all" is a small follow-up. |
| 13 | **`GroupKind.EMI` and split templates are out.** | A split template needs a legs table; a separate request. |
| 14 | **The scheduled job is an in-process timer** from `instrumentation.ts`, not a second container or an external cron. | See the risk in §11 and its fallback. |
