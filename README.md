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
