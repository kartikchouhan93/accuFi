# AccuFi M6 — CSV import: design

**Status:** Draft, awaiting approval. **Date:** 2026-11-02. **Builds on:** `2026-09-11-accufi-design.md` §8.6 (CSV import), §6.4, §5 (flow rules), EC-17, EC-46, EC-53 to EC-60. M0–M5 are merged.

The user asked for the design to be drafted straight from the spec, without a question round. Everything the spec leaves open is decided here and listed in **Calls I made** at the end, each with what it costs if wrong.

## 1. Intent

Typing a month of bank and card activity by hand is the chore that decides whether a ledger stays alive. M6 lets the user bring a statement file in: upload it, say how its columns map, look at what will be recorded, decide for each row which ledger it belongs to, and commit. The spec's five stages are the shape of the whole milestone, and its organising rule is: **nothing is committed until the last stage, and a commit is all or nothing.**

The second rule, from the same place: **nothing is dropped silently.** A probable duplicate is flagged, never discarded. A row that cannot be read is shown with its reason, never skipped without a word. A row that matches a pending recurring entry is offered a link, never double counted.

The exit criterion from the spec: **a real bank statement imports with duplicates flagged and the batch reversible.**

## 2. Goals, non-goals, anti-goals

**Goals**
- Upload a CSV for one account (an `ASSET` or `LIABILITY` ledger the user owns), identified by a SHA-256 of its bytes; a prior upload of the same bytes warns before anything proceeds (EC-54).
- Map the file with an **explicit** delimiter, encoding, number of header rows to skip, date format and column roles (date, description, and either one signed amount column or separate debit and credit columns, EC-59). A date format is never inferred (EC-53). A saved **profile** reuses a mapping per institution.
- A live preview of the first twenty rows exactly as they will be recorded, with the decoded text visible so a wrong encoding is obvious before anything is staged (EC-58).
- **Stage** every row with a status: ready to review, errored with its reason (EC-56), or skipped. A malformed row never stops the others.
- **Review** each row: pick the counterpart ledger (suggested from rules learned in earlier imports), see and decide probable duplicates (EC-55), and link a row to a pending recurring occurrence it matches (EC-46).
- **Commit** every accepted row in one database transaction; a failure writes nothing and leaves the batch reviewable (EC-57). Each created transaction carries its `importBatchId` and `importRowId`.
- **Reverse** a committed batch in one action: all its transactions soft-delete together (EC-60).
- Learn from commits: the ledger chosen for a description becomes the next suggestion.

**Non-goals (M6)**
- Bank APIs, account aggregators, OFX, QIF, PDF or Excel input. CSV only (spec §1.2).
- Auto-detecting the delimiter, encoding or date format. The preview shows the effect of a choice; the user makes it.
- Splitting a row across several ledgers, importing investment purchases or sales (anything into or out of a lot-mode investment), importing balances or running totals from the file.
- Flagging duplicates **within** the same file (two identical coffees on one day are normal), and fuzzy duplicate matching beyond date ±3 days, amount, direction.
- A screen to edit or delete learned rules, scheduled or recurring imports, email-in, bulk re-categorising of already-imported transactions.
- Changing M4, M5, or the transaction screen beyond what §7 lists.

**Anti-goals (a failure even if every test passes)**
- A commit that leaves some rows written and others not, or that writes the same row twice (a double click, two tabs, a retry).
- A row dropped, merged or auto-resolved without the user seeing it.
- A date that means one thing to the importer and another to the user (`03/04/2026`).
- An amount that is rounded, a sign that is guessed, or a direction that differs from the mapping the user confirmed.
- A reversal that leaves any of the batch's transactions live, or touches a transaction the batch did not create.
- A file's contents, or another user's batch, visible to anyone else.

## 3. Constraints

- Layering unchanged (§9.2): `src/domain` pure (no Prisma, Next or server imports; relative value imports): the CSV tokenizer, the date and amount parsers, description normalisation, duplicate and occurrence matching. A new `import-repository.ts` takes `userId` first and scopes every query and join. `import-service.ts` orchestrates. `src/lib/schemas/import.ts`, `src/lib/import-view.ts` hold schemas and plain-data views. `src/app/import/**` Server Components pass plain props; Server Actions or route handlers do the writes.
- Money is integer paise (`bigint`), never `number`; text across the server/client boundary. Dates are `CalendarDate`s. Parsing never rounds: more than two decimals, or an unparseable amount, is a row error.
- A transaction is recorded through the same rules as any other: flow legality (`validateTransaction`), archived ledgers refused, no investment held by lots as counterpart, the overdraft guard for `blockNegative` ledgers, and a unique idempotency key `import:<rowId>`.
- Upload limits: at most **5 MB** and **20,000 rows** per file; a file with NUL bytes is refused as not text. The Next Server Action body limit (1 MB by default) must be raised to fit, or the upload must go through a route handler that enforces the cap itself.
- The file's raw bytes are kept only while the batch is not finished (needed to re-map) and are deleted when it is committed, discarded or reversed. Statement text is the user's most sensitive data: it is never logged, never sent anywhere, never in an error message.
- Cross-user isolation tested per repository method with a foreign user's ids; the isolation e2e is extended to `/import`.
- Tests never depend on the real date; the e2e upload fixtures are synthetic files in the shapes of common bank and card exports, not real statements. Both timezone passes stay green.
- No new runtime dependency is expected: the tokenizer is hand-written to RFC 4180 and decoding uses `TextDecoder`.
- Palette: Graphite & Azure tokens only (no purple, no yellow); keyboard reachable, visible focus, reduced motion respected, no horizontal scroll at 375px (wide tables scroll inside a labelled, focusable frame).

## 4. How a file becomes rows (domain)

**Tokenizer.** Splits decoded text into rows of cells for a chosen delimiter (comma, semicolon, tab, pipe). Handles quoted fields, doubled quotes inside them, delimiters and newlines inside quotes, CRLF and LF, a leading BOM, and a final line without a newline. A quote that never closes is a row error for that row's span, not an exception.

**Mapping.** `{ delimiter, encoding, skipRows, dateFormat, decimalSeparator, signConvention, columns }` where `columns` names the date and description columns and either `amount` or `debit` and `credit`.

**Dates.** A closed list of formats, chosen explicitly: `DD/MM/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD`, `DD-MM-YYYY`, `DD/MM/YY`, `MM/DD/YY`, `DD-MMM-YYYY`, `D MMM YYYY`. The parse is exact: `31/02/2026` is an error, not March; a two-digit year means 20yy. The same text under `DD/MM/YYYY` and `MM/DD/YYYY` gives different dates, which is why the choice is never inferred.

**Amounts.** Accepts Indian and international digit grouping, an optional `₹` or `Rs`, a leading or trailing minus, accounting parentheses `(500.00)`, and a trailing `Dr`/`Cr`. The decimal separator is a mapping choice (`.` default). Zero is an error. Result: an unsigned paise amount plus a direction.

**Direction.** Relative to the account the file is for, in ledger terms: **out** means the account is the source (`account → counterpart`: money leaves a bank account, or a charge increases what a card owes), **in** means the account is the destination (`counterpart → account`). With one signed column the user picks the convention explicitly (**positive = out** or **positive = in**; the default offered depends on the account kind: a card statement usually lists charges as positive). With separate columns, debit is out and credit is in; a row with both filled or neither is an error. `Dr`/`Cr` suffixes override the sign convention for that row.

**Description.** Kept as typed, plus a normalised key for matching: upper-cased, whitespace collapsed, digit runs and common reference tokens removed, truncated to 40 characters.

## 5. Data model

One migration, CHECK constraints in its SQL (as the earlier migrations did).

```
enum ImportBatchStatus { UPLOADED STAGED COMMITTED REVERSED DISCARDED }
enum ImportRowStatus   { PENDING READY SKIPPED ERRORED COMMITTED }

model ImportProfile {            // a saved mapping
  id, userId, name, nodeId? (the account it was made for), settings Json, createdAt, updatedAt
  @@unique([userId, name])
}
model ImportBatch {
  id, userId, nodeId (the account), fileName, fileSize Int, fileHash (sha256 hex),
  fileBytes Bytes?             // dropped when the batch ends
  status, mapping Json?, profileId?,
  rowCount Int, committedAt?, reversedAt?, createdAt
  @@index([userId, fileHash])  @@index([userId, createdAt])
}
model ImportRow {
  id, userId, batchId, line Int,           // the line in the file
  raw String[]                            // the cells as read
  status, errorReason String?,
  occurredOn DATE?, amountPaise BigInt?, direction ("OUT"|"IN")?, description String?, descriptionKey String?,
  counterpartNodeId String?,
  duplicateOfTransactionId String?,       // the probable duplicate found, when any
  occurrenceId String?,                   // a pending recurring occurrence it was linked to
  transactionId String? @unique           // what it became
  @@unique([batchId, line]) @@index([userId, batchId, status])
}
model CounterpartRule {          // learned from commits
  id, userId, direction, descriptionKey, nodeId, hits Int, updatedAt
  @@unique([userId, direction, descriptionKey])
}
```

`Transaction` gains nullable `importBatchId` and `importRowId` (both foreign keys, RESTRICT, with an index on the batch). A transaction made by hand has neither. CHECKs: positive amounts, `fileHash` is 64 hex characters, a committed row has a transaction and a counterpart. The foreign keys to `LedgerNode` are RESTRICT like the others, so **deleting a ledger an import batch, profile or rule names must refuse with a message** (the M4 and M5 lesson), except that rules and profiles for a ledger being deleted are removed with it (they carry nothing the user created by hand beyond a suggestion).

## 6. The five stages

1. **Upload** (`UPLOADED`). Account (live `ASSET` or `LIABILITY`), file, optional profile. The server checks size and text-ness, hashes, and looks for an earlier batch of this user with the same hash that was not discarded: if one exists the user sees when it was uploaded and what became of it (staged, committed, reversed) and must confirm to continue. Bytes are stored on the batch.
2. **Map and preview.** One screen: the mapping controls (from a profile when chosen) beside a live table of the first twenty rows as they will be recorded (date, description, amount, direction, or the error), with the decoded text shown. "Save as profile" stores the mapping under a name. Moving on **stages** the rows.
3. **Stage** (`STAGED`). Every row is parsed, written to `ImportRow` as `PENDING`, `ERRORED` (with its reason) or, nothing else. The counterpart is pre-filled where a learned rule matches (and is legal), probable duplicates are looked up, and pending recurring occurrences are matched. A row count over the cap refuses the batch with a clear message.
4. **Review.** Paginated list with filters (needs a decision, duplicates, errors, ready, skipped). Per row: counterpart picker limited to ledgers that are legal for the direction (the transaction form's rules), a **Skip**, and for a flagged duplicate the decision **Import anyway** or **Skip as duplicate** with a link to the transaction it matches. A row matching a pending recurring entry offers **Link to <rule name> due <date>**, which takes the other ledger from the rule. "Use this ledger for every row that reads the same" applies a choice to rows with the same description key. A row becomes `READY` when it has a counterpart and, if flagged, a decision.
5. **Commit.** Enabled when no row is `PENDING`. Locks the batch (`FOR UPDATE`), requires it to be `STAGED` (a second commit returns the first result), re-validates each `READY` row against the ledgers as they are now (a ledger archived since staging, or a flow that stopped being legal, refuses the whole commit and names the rows), then in **one** database transaction inserts all transactions with key `import:<rowId>`, marks linked occurrences posted with their transaction, marks rows `COMMITTED`, records `committedAt`, deletes the file bytes and updates the learned rules. Any failure rolls everything back and the batch stays `STAGED`.

**Reverse** a `COMMITTED` batch: in one transaction soft-delete every live transaction carrying its `importBatchId`, return occurrences it had posted to `PENDING`, set the batch `REVERSED`. Repeating it changes nothing. It never touches a transaction the batch did not create, including one the user has since edited (it is still the batch's).

**Discard** an `UPLOADED` or `STAGED` batch removes its rows and bytes and marks it `DISCARDED`.

## 7. Matching

- **Probable duplicate (EC-55).** A row is flagged against a live transaction that touches the batch's account, has the same amount, the same direction relative to that account, and a date within three days either side. One query fetches the account's transactions in the file's date range widened by three days; matching is a pure function. Several candidates: the closest by date, then by creation, is shown. Imported earlier or typed by hand makes no difference.
- **Pending recurring occurrence (EC-46).** A `PENDING` occurrence of a live rule whose template touches the account with the same amount and direction and a due date within three days. Linking records the **bank's** date and amount, takes the counterpart from the rule, and at commit marks the occurrence posted with the new transaction, so the inbox clears and nothing is entered twice.
- **Suggested counterpart.** The learned rule for `(direction, descriptionKey)`: exact key first, then the longest rule key contained in the row's key. A suggestion that is not legal for the direction, or whose ledger is archived, is not offered. A different choice at commit replaces the rule (the latest choice wins).

## 8. Screens

- **Import** (`/import`, a new nav destination): the batches, newest first, each with account, file name, rows, status and the next action (Continue, Review, Reverse, Discard); a **New import** button; an empty state saying what an import is for.
- **New import / Map / Review** under `/import/new` and `/import/[id]/...`, in the visual language of the Recurring and Budgets screens. Review is the long one: filters as links, a row card or table row per transaction with the counterpart control, status chips with text (never colour alone), the flagged-duplicate comparison side by side, and a sticky summary ("3 need a decision, 2 errors, 41 ready") with the Commit button. Wide tables scroll inside a focusable, labelled frame.
- **Batch page** (`/import/[id]` once committed): what was imported (counts, date range, total in and out), a link to the Transactions list filtered to the batch (a new `batch` filter on the Transactions screen, shown with its filtered total), and **Reverse this import** behind a confirm.
- Transactions rows that came from an import show a small "Imported" tag linking to their batch.

## 9. Testing

- **Domain** (both timezone passes): the tokenizer (quotes, doubled quotes, embedded delimiters and newlines, CRLF, BOM, trailing newline, an unterminated quote, an empty field, ragged rows); each date format including the ambiguous `03/04/2026` both ways, `31/02/2026`, a leap day, two-digit years; amounts (`1,23,456.78`, `₹1,200.00`, `(500.00)`, `500.00 Dr`, `-500`, a third decimal, zero, text); direction (single column both conventions, debit/credit, both or neither filled, `Dr`/`Cr` override); description keys; duplicate matching at exactly 3 and 4 days, the other direction, the other account, a deleted transaction, several candidates; occurrence matching; rule matching (exact, contained, longest, illegal suggestion hidden).
- **Service** (real database): staging a file with a bad row in the middle (EC-56) leaves the rest staged; a re-upload of identical bytes warns (EC-54) and a discarded earlier batch does not; the size and row caps; commit writes exactly the ready rows with the right from/to, amount, date, note and keys; **commit atomicity** (force the third row to fail: nothing written, the batch still `STAGED`, no rule changed); commit twice and two concurrent commits give one set of transactions; a ledger archived between staging and commit refuses the whole commit and names rows; the overdraft guard; occurrence linking clears the inbox and records the bank's amount; reversal soft-deletes exactly the batch's transactions, balances return to exact earlier values, linked occurrences come back, a second reversal is safe, a manually created transaction in the same period is untouched; learned rules are written and replaced; deleting a ledger a batch names is refused.
- **Isolation:** every repository method with a foreign user's ids; the isolation e2e covers `/import` and a foreign batch id.
- **e2e:** upload a synthetic statement through the browser, map it with an explicit date format, see the preview, stage, review (choose counterparts, a flagged duplicate against a hand-entered transaction, an errored row), commit, see the transactions and balances; import the same file again and see the warning; import an overlapping file and see duplicates flagged; link a row to a pending recurring entry; reverse the batch and see balances return; keyboard and dark theme. Dates in fixtures derive from the user's today.

## 10. What is left to the builder

The tokenizer and parsers' internals; the exact layout of the map and review screens within §8; copy for errors, empty and refusal states; how the upload reaches the server (a Server Action with the raised body limit, or a route handler) as long as the cap and text check are enforced server-side; the Review page's pagination and filter URL shape; the SQL shape of the duplicate lookup; the form of the `mapping` JSON.

## 11. Calls I made (change any)

| # | Call | Costs if wrong |
|---|---|---|
| 1 | **Hand-written CSV tokenizer**, no dependency. | Swapping in a parser library later is contained in one module. |
| 2 | **Raw bytes are stored on the batch** until it ends, then deleted. | Without them, any re-map would need a re-upload; storing the parsed cells instead is the alternative. |
| 3 | **The file is for one account** (`ASSET` or `LIABILITY`), chosen at upload; investments are not importable. | A statement mixing accounts needs a column for the account; a large change. |
| 4 | **Direction is explicit** (a sign convention the user confirms; `Dr`/`Cr` overrides), with a default by account kind. | A wrong default flips every row; the preview and the confirmation exist for that. |
| 5 | **A closed list of eight date formats**, two-digit years mean 20yy. | A new format is one entry. |
| 6 | **Duplicates are matched against any live transaction on the account** (imported or typed), ±3 days, same amount and direction; **not within the file**. | Within-file flags would warn on every legitimate repeat purchase. |
| 7 | **Stages 2 and 3 are one screen** (mapping beside a live twenty-row preview). | Two routes instead of one; cosmetic. |
| 8 | **Commit re-validates against today's ledgers and refuses the whole batch** if any row is no longer legal, naming them. | Dropping the bad rows silently would break "nothing is dropped silently". |
| 9 | **The overdraft guard applies to the batch as a whole** for `blockNegative` ledgers. | A statement that legitimately overdraws a guarded account must be unguarded first; rare. |
| 10 | **Linking a recurring occurrence records the bank's date and amount** and takes the counterpart from the rule. | Using the rule's template instead would record a number that never happened. |
| 11 | **Reversal returns occurrences it had posted to pending**, unlike M4's "deleting a transaction leaves it posted". | Leaving them posted would silently lose a month's recurring entry after a reversal. |
| 12 | **Learned rules: exact key, then longest contained key; the latest choice wins**; no screen to manage them. | A rule screen is a later request; a wrong rule is overridden per row. |
| 13 | **Limits: 5 MB and 20,000 rows.** | Two constants. |
| 14 | **Deleting a ledger an import batch names is refused**; its profiles and rules go with it. | Without it the foreign key surfaces as a raw error page. |
