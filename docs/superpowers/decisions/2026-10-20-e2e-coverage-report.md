# E2E coverage report, 2026-10-20

Branch `test/e2e-coverage`. Tests only: no production code was changed (`git diff 53bd0a5..HEAD -- src` is empty).

## What was added

| Commit | Content |
|---|---|
| `ea7a820` | `fixtures.ts`: a `pair` fixture (users A and B, each signed in inside its own browser context) and `deleteUser` exported. |
| `ab1cfc0` | `auth.spec.ts`, 15 tests: the authentication journey. |
| `ff90d4d` | `screens.ts` (shared transaction-screen locators, `record`, and `watchActions`, which reads or rewrites what a page sends to a Server Action); `auth.spec.ts` switched to it. |
| `48c9ad8` | `isolation.spec.ts`, 7 tests. |
| `209e524` | `flows.spec.ts`, 6 tests, plus a `loan` helper in `seed.ts`. |

### auth.spec.ts (all ten requested behaviours, plus three lockout variants)

- Signup through the form lands signed in as that address, and the four system nodes exist (database rows and the `System` tag on the ledger screen).
- A duplicate email is refused in words, including the same address in a different case. The first account's hash is unchanged.
- A short password is refused at the browser (`minLength`, nothing is sent) and at the server (`noValidate`, "Password must be at least 8 characters").
- Login through the form works. It sets a session, and `/login` then redirects to `/`.
- A wrong password is refused and nobody is signed in.
- **Enumeration:** an unknown email and a wrong password are observed side by side. The compared fields are the HTTP status, the Server Action response body (the timestamp and render timing Next puts in every response are stripped), the `set-cookie` header, the cookies, the final path and the alert text. They must be deep-equal. Neither address may appear in the other's response.
- Lockout: ten wrong attempts are each answered as "Incorrect email or password.", and the eleventh, with the **right** password, is "Too many attempts." and gets no session. Also covered: an unknown email that has spent its budget gets the same words, and the per-account counter (30, keyed on email alone) refuses the right password while the per-address counter is fresh.
- Sign-out lands on `/login`, with no session cookie, the three protected pages redirecting, and Back plus reload still redirecting.
- `/`, `/nodes` and `/transactions` each answer an unauthenticated request with a 307 to `/login`, and a browser lands on the form.
- `/api/health` answers 200 `{status:"ok", database:"up"}` without a session and without a redirect.

Rate-limit hygiene: every test uses its own `uuid@e2e.test` address, so a lockout strands nobody. Counters a test spends (login, account, signup, and the instance-wide signup-address counter) are cleared in a `finally` through `clearAttempts`. After the three e2e runs there were no users left in the test database. The only leftover counters were 4 rows written by the Vitest run, whose timestamps match its start time.

### isolation.spec.ts

A is seeded with names, amounts and a note that are unmistakable ("Zephyr Vault Savings", ₹9,87,654.32, ₹1,23,456.78, ...). A's own pages are asserted to show them first, so a search that finds nothing is searching for something real. A leak is looked for in the rendered text **and** in the page HTML, which carries everything the server handed to client components, for names, amounts as printed and as paise, emails, user id, node ids and transaction ids.

1. B's ledger and dashboard: net worth is exactly ₹750.00, one account row, nothing of A's.
2. B's transaction list holds exactly B's two rows. Searches by A's words, A's exact amount, a min amount above B's, and kind plus note all return the empty state.
3. B's pickers: source, destination (for three kinds of source), the "Involving" filter, and both split legs offer only B's nodes, by label and by option value (id).
4. A URL with A's node ids, A's transaction id as a node, A's transaction id as a search, and `deleted=1` gives B a screen **byte-identical** to the one for an id that exists nowhere.
5. Three replays (edit, delete, record): B does something ordinary on its own screen, and the request body is rewritten so B's id is swapped for A's. The edit replay targets A's row at a later version than B's, so a version check made before the owner check would have produced a conflict carrying A's row. Each replay is refused with the "no longer exists" text, and the wire response is deep-equal to the response for an id that exists nowhere. A's rows are asserted unchanged in the database, and the transaction counts of both users are unchanged. The test also asserts the rewrite actually fired, so a replay that went out untouched cannot pass.

I checked the tests can fail. With `findNodes` temporarily unscoped, all 7 failed. With `findTransactionById` temporarily unscoped, the edit replay failed. The delete replay did not fail, because `softDeleteTransaction` has its own `userId` scope, so the row is still protected one layer down. Both mutations were reverted (`git status` clean of `src`).

### flows.spec.ts

- **Transfer** (bank to bank) and **ATM** (bank to cash), one shared routine. Both balances move. Net worth is read from the ledger screen before and after and is unchanged. No row shows `spent` or `received`, and every starter expense ledger reads ₹0.00. The database's income and expense totals, system nodes excluded, are unchanged. The kind filters list the opening balances and never the transfer. Control: a real ₹500 spend then shows `₹500.00 spent`, moves net worth by exactly ₹500, and moves the database total.
- **EMI split:** entered through the split form. The loan shows ₹1,92,000.00 owed (not ₹1,90,000.00), the interest ledger shows ₹2,000.00 spent, net worth falls by the interest alone (-₹1,00,000.00 to -₹1,02,000.00), and the database has the loan at -192000000 paise and the two legs in one group.
- **Refund:** ₹2,000 spent and ₹500 refunded reads ₹1,500.00 spent, with net worth up ₹500.
- **Refund over the spend (EC-20):** ₹300 spent and ₹450 refunded is accepted with no warning. The ledger reads `₹150.00 net refund` with no minus sign and no `spent`, and the database holds -15000 paise.
- **Income straight to a loan:** Salary to loan shows ₹30,000.00 owed and Salary `₹20,000.00 received`. The bank account is untouched, and its only transaction is its opening balance.

## Final counts

- Vitest: 708 passed, run in both time zones. This is unchanged: the new files are e2e only.
- Playwright: **76 passed**, 0 failed, 0 flaky, 0 skipped. That is 48 existing plus 28 new (auth 15, isolation 7, flows 6).
- Run three times: twice with the default 4 workers (30 s each) and once with `--workers=1` (1.1 min), so a serial order and a parallel order both pass. Each run left no `next dev` behind.
- `bun run lint`, `bunx tsc --noEmit` and `bunx next build` are clean. No lint rule was disabled and no `waitForTimeout`, `.skip` or `.only` was added to the new files.

## Findings: possible product defects (not fixed)

1. **A refused signup empties the form.** The signup form (and, since `AuthForm` is shared, presumably the login form) is a React 19 `<form action>`. React resets an uncontrolled form once its action settles, whether the action succeeded or refused. After "An account with this email already exists." or "Password must be at least 8 characters", both the email and the password the person typed are gone. The brief asks for "keeping what was typed". This is recorded as `test.fail("keeps the email and password after a refused signup")` in `auth.spec.ts`. It keeps the suite green while the defect stands, and it turns red the day it is fixed, at which point the marker should be removed. Playwright prints it with a `✘` and counts it as passed. A fix needs a decision (controlled inputs, or `defaultValue` from the returned state). The login form's behaviour is the same mechanism but is not separately asserted.
2. **Every failed login writes an Auth.js error and stack trace to the server log.** `[auth][error] CredentialsSignin ...` plus about 25 stack lines is printed for each wrong password, unknown email and rate-limited attempt. This comes from Auth.js's default logger and is silenced only by a `logger` option in `src/server/auth.ts`. The e2e output is therefore **not pristine any more**: 16 such traces per run, all from the new tests that deliberately fail logins. The earlier 48-test run printed none. In production the same noise is one trace per failed attempt, so an attacker can flood the log. I did not hide it with `stderr: "ignore"`, which would also hide real server errors.

Observation, not a defect: sessions are JWTs and cannot be revoked server-side (documented in `auth.config.ts`). A copy of the cookie taken before sign-out would still be accepted until it expires. I did not assert that.

## Deliberately left out

- **The signup rate limit (30 per address).** Its counter is instance-wide and shared by every signup, so tripping it would strand the other signup tests running in parallel, and 30 real signups would be slow. It needs a serial group or its own server run.
- **The 30-per-(address, email) login limit that applies once `TRUSTED_PROXY_HOPS` is set.** That needs a server restarted with different environment, which `playwright.config.ts` does not offer. The per-account limit, which a client cannot influence, is covered by seeding.
- **A pagination cursor aimed at A's transaction id.** The cursor is an `(occurredAt, id)` pair that is never looked up as a row, so there is nothing to leak. It would need 51+ rows for B to produce a "Load more" request to rewrite.
- **Replaying restore, ungroup and record-split against A's ids.** Edit, delete and record cover the three distinct lookups, and the repository tests cover the rest exhaustively.
- **"Not income or expense anywhere on screen" beyond the ledger and the kind filters.** The dashboard has no income or spending figures in M1, and reports are M3.
- The three older specs keep their own copies of `form`, `entries`, `balances` and `optionsOf`. I did not refactor them, to keep this change to additions only.
