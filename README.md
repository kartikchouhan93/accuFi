# AccuFi

Personal finance tracker. Next.js 16 (App Router) + Prisma 6 + PostgreSQL 16, run on Bun.

Product requirements and design: `docs/superpowers/`.

## Getting started

```bash
cp .env.example .env          # then edit the secrets
bun install
docker compose up --build -d  # postgres:16 + the app (http://localhost:3000)
bun run test                  # smoke test hits the running stack via APP_URL
```

If host port 3000 is taken, set `APP_PORT=3100` (and `APP_URL=http://localhost:3100`) in `.env`.

Local development without the app container:

```bash
docker compose up -d postgres
bunx prisma migrate dev       # or: bun run db:migrate
bun run dev
```

Scripts: `dev`, `build`, `start`, `lint`, `test`, `test:watch`, `test:e2e`, `db:migrate`, `db:deploy`, `db:studio`.
Always use Bun (`bun install`, `bun run ...`); do not use npm.

### End-to-end tests

`bun run test:e2e` drives the real screens in a browser (Playwright). It is separate from `bun run test` because it boots a server and a browser. It uses the installed Google Chrome (no browser download), starts its own `next dev` on port `E2E_PORT` (default 3200, not `APP_PORT`, which belongs to the Docker stack), and uses the `<database>_test` database like the Vitest suites, never the dev database. A focused run: `bunx playwright test tests/e2e/nodes.spec.ts`.

## Deployment

- **`AUTH_URL`** (compose passes `APP_URL` as `AUTH_URL`) must be the public URL of the app. The server refuses to start in production without it, because Auth.js would otherwise build redirects from the client-supplied `Host` header.
- **Terminate TLS in a reverse proxy.** The session cookie is `Secure` in production, so it is only sent over HTTPS (browsers also accept it on `http://localhost`).
- **Tell the app about your proxy: `TRUSTED_PROXY_HOPS`.** Login and signup are rate limited per client address and email. The address comes from `X-Forwarded-For`, which any client can forge, so it is **ignored unless you set `TRUSTED_PROXY_HOPS`** to the number of reverse proxies in front of the app (default `0`: the app is reached directly and every client shares the address "unknown"). Set it to `1` behind one proxy that appends the real client address (nginx `proxy_add_x_forwarded_for`, Caddy, Traefik), `2` behind two, and so on. Setting it higher than the real number lets a client choose its own address. Each account is also capped independently of address, so how many wrong guesses lock an account for 15 minutes depends on that setting: with the default (`0`) every client shares the address "unknown", the per-address-and-email limit is in effect a per-account limit, and the threshold is **10**; once you declare a proxy, one address can make 10 guesses and the account-wide cap of **30** (across all addresses) becomes the threshold. Signup is capped per address.
- **Recurring sweep: `RECURRING_SWEEP` and `RECURRING_SWEEP_INTERVAL_MS`.** The app starts an in-process timer when the server boots (`src/instrumentation.ts`), which runs once at startup and then hourly; no cron or second service is needed. Set `RECURRING_SWEEP=off` to disable it (the e2e server does). `RECURRING_SWEEP_INTERVAL_MS` overrides the hour with a positive number of milliseconds; anything else is ignored. The timer lives in the one server process, so it needs the app to be running (a process that is switched off catches up when it starts again).

## Recurring entries

A recurring rule describes something that repeats: rent, a SIP, a subscription, the card bill. It holds a transaction template (a source, a destination, an amount, a note and tags) and a schedule (daily, weekly, monthly, quarterly or yearly, every N of them, on a day of the month or week, from a start date, with an optional end date or number of entries). Rules live at `/recurring`, and "Make recurring" on a transaction row starts one from that transaction.

**Nothing posts until you confirm it, unless a rule is set to post automatically.** When a rule falls due it proposes an entry in the inbox on the Recurring screen. A proposal is in no balance, net worth or report; you post it as shown, change it first, or skip it (a skip can be put back). Only a rule you turn "Post automatically" on for records itself on its day, and a rule that buys into an investment valued by quantity cannot, since each purchase needs its quantity. The number waiting shows on the Recurring link in the navigation and on the dashboard.

Entries are proposed by a catch-up that runs at every sign-in and on an hourly in-process timer, so an instance that was switched off for a week proposes everything it missed once it is running again, though at most 100 entries per rule per run, so a long daily gap fills over several hourly runs. The timer needs no cron job; `RECURRING_SWEEP` and `RECURRING_SWEEP_INTERVAL_MS` are described under [Deployment](#deployment).

## Budgets

A budget is a monthly cap on an expense ledger: Groceries, ₹12,000 a month, from a month you choose and, if you like, until a last month. Budgets live at `/budgets`, which shows one month at a time with a card for each budget: what is used, what is left or how far over, a bar for the share used, and where the month ends at this pace (once a week of the month has passed and something has been spent). A budget on a parent ledger counts the ledgers inside it, a ledger inside it may have a budget of its own, and a refund into a budgeted ledger takes that much off the month it happened in. A budget that starts in a later month has no card yet and is listed under Upcoming, where it can be edited or deleted. Every "used" figure is a link to exactly the entries it is made of, and is the same figure the Transactions screen totals for them.

**A budget warns and never blocks.** Recording an expense that leaves a budget at 80% or more of its amount says so in the notice that confirms it ("Groceries is at 85% of its budget this month."), and one that takes it over says by how much. The entry is recorded either way, and the dashboard shows "1 budget needs attention" while a budget is near or over this month. Nothing is refused, held back or sent anywhere.

**Nothing is frozen.** A month's figures are not stored: they are worked out from your transactions each time you look. An expense dated in a month that has closed changes that month's status the moment it is recorded, and deleting it changes it back. A new amount applies from the month you pick (this month by default), so earlier months keep the amount that applied to them; picking the first month of the span you are editing corrects that span's amount in place instead (a budget that was split has one span for each amount, and Edit works on one span at a time; an amount you save unchanged changes nothing).

Rollover is off by default; switched on, whatever a month leaves unspent is added to the next month's available amount (an overspent month carries nothing forward, never a debt).

A ledger that a budget uses cannot be deleted until the budget is (or it can be archived, which keeps the budget); deleting a budget never touches a transaction.

## Importing a statement

An import reads a CSV statement from a bank or card account, lets you say what each column means, shows a live preview of what it would record, and turns the rows you confirm into transactions on one account of your own. Imports live at `/import`; "New import" starts one with a file, and reuses a saved mapping if you already have one for this bank.

**Nothing is recorded until you commit.** Uploading a file only stores it; choosing a mapping only previews it; staging only reads it into rows, each pending a decision, that you can import or skip one at a time (or in bulk, for rows that read the same). Committing is the one step that turns the rows you chose to import into real transactions and moves the account's balance; nothing before it writes anything.

**The date format is always chosen, never guessed.** `03/04/2026` is the 3rd of April on one bank's export and the 4th of March on another's. The mapping screen asks which format the file uses, with a live preview that changes the moment you change it, rather than inferring one from the data and risking a transaction recorded on the wrong day with no warning.

**A likely repeat is flagged, never dropped.** A row that matches an existing transaction on the account (the same amount and direction, within a few days) is shown beside the transaction it probably repeats, so you decide — import it anyway or skip it as a duplicate — instead of it silently doubling your balance or silently vanishing. Uploading the exact same file a second time is caught before it is even staged, with a warning and a confirmation to go past it.

**Reversing a committed import** undoes it in full: every transaction it created is deleted and the account's balance returns to exactly what it was before, and any recurring entry the import had posted goes back to waiting in the inbox. A reversed import stays on the list, showing what it did, in case you need to look again.

The statement's own bytes are kept only for as long as the batch might still need remapping or deciding: once it is committed, discarded, or (having already been committed) reversed, its file is deleted from the database — only the transactions it made, or the fact that it made none, remain.

## Runtime spike outcome (spec §9.1)

Question: does Next.js 16 + Prisma 6 work on the Bun runtime, in Docker, against Postgres 16?

**Result: yes. The Bun runtime works; the Node 22 fallback was NOT needed.**

- Bun 1.4.3, Next.js 16.1.3, Prisma / @prisma/client 6.19.3, Vitest 5.0.5, PostgreSQL 16 (`postgres:16-alpine`).
- The container image is `oven/bun:1.4.3` (pinned to the validated version) end to end, and the Dockerfile runs `bun --bun run build` / `bun --bun run start` so the Bun runtime is explicit rather than relying on the image's `node` symlink. Inside it `node` resolves to Bun (`/usr/local/bun-node-fallback-bin/node -> bun`), so `next start` runs on the Bun runtime (verified: the server process executable is `/usr/local/bin/bun`).
- `bunx prisma generate`, `bunx prisma migrate deploy` (on container start, against a fresh volume) and `bun run build` all succeed inside the container.
- `GET /api/health` returns `{"status":"ok","database":"up"}` from the container, and `503 {"status":"error","database":"down"}` when Postgres is stopped.
- On the host: `bun run dev`, `bun --bun run dev`, `bun run build`, `bunx prisma generate` and `bunx prisma migrate dev --name init` all work. Note that without `--bun`, host commands run under the host's Node via the tools' shebangs; only the container exercises the pure-Bun runtime.
- Vitest runs fine under Bun (`bun run test`); no switch to `bun test` was needed.
- Prisma's own postinstall is not blocked on Bun 1.4.3 (`@prisma/client` is on Bun's default trusted list), but nothing here depends on that list: `package.json` has a `postinstall` of `prisma generate`, which a project's own scripts always run, so a fresh `bun install` leaves the generated client in place for `tsc` and the tests. The Dockerfile installs with `--ignore-scripts` (no schema is copied yet at that stage) and runs `prisma generate` in its build stage.
