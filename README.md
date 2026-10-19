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

Scripts: `dev`, `build`, `start`, `lint`, `test`, `test:watch`, `db:migrate`, `db:deploy`, `db:studio`.
Always use Bun (`bun install`, `bun run ...`); do not use npm.

## Deployment

- **`AUTH_URL`** (compose passes `APP_URL` as `AUTH_URL`) must be the public URL of the app. The server refuses to start in production without it, because Auth.js would otherwise build redirects from the client-supplied `Host` header.
- **Terminate TLS in a reverse proxy.** The session cookie is `Secure` in production, so it is only sent over HTTPS (browsers also accept it on `http://localhost`).
- **Tell the app about your proxy: `TRUSTED_PROXY_HOPS`.** Login and signup are rate limited per client address and email. The address comes from `X-Forwarded-For`, which any client can forge, so it is **ignored unless you set `TRUSTED_PROXY_HOPS`** to the number of reverse proxies in front of the app (default `0`: the app is reached directly and every client shares the address "unknown"). Set it to `1` behind one proxy that appends the real client address (nginx `proxy_add_x_forwarded_for`, Caddy, Traefik), `2` behind two, and so on. Setting it higher than the real number lets a client choose its own address. Whatever you set, each account is also capped independently of address (30 attempts per 15 minutes), and signup is capped per address.

## Runtime spike outcome (spec §9.1)

Question: does Next.js 16 + Prisma 6 work on the Bun runtime, in Docker, against Postgres 16?

**Result: yes. The Bun runtime works; the Node 22 fallback was NOT needed.**

- Bun 1.4.3, Next.js 16.1.3, Prisma / @prisma/client 6.19.3, Vitest 5.0.5, PostgreSQL 16 (`postgres:16-alpine`).
- The container image is `oven/bun:1.4.3` (pinned to the validated version) end to end, and the Dockerfile runs `bun --bun run build` / `bun --bun run start` so the Bun runtime is explicit rather than relying on the image's `node` symlink. Inside it `node` resolves to Bun (`/usr/local/bun-node-fallback-bin/node -> bun`), so `next start` runs on the Bun runtime (verified: the server process executable is `/usr/local/bin/bun`).
- `bunx prisma generate`, `bunx prisma migrate deploy` (on container start, against a fresh volume) and `bun run build` all succeed inside the container.
- `GET /api/health` returns `{"status":"ok","database":"up"}` from the container, and `503 {"status":"error","database":"down"}` when Postgres is stopped.
- On the host: `bun run dev`, `bun --bun run dev`, `bun run build`, `bunx prisma generate` and `bunx prisma migrate dev --name init` all work. Note that without `--bun`, host commands run under the host's Node via the tools' shebangs; only the container exercises the pure-Bun runtime.
- Vitest runs fine under Bun (`bun run test`); no switch to `bun test` was needed.
- Prisma's postinstall is blocked by Bun's default lifecycle-script policy; this is harmless because `prisma generate` is run explicitly (Dockerfile, and `prisma migrate dev` generates automatically).
