FROM oven/bun:1.4.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# Without scripts: the root postinstall is `prisma generate`, and only package.json and the lockfile are here, so there
# is no schema to generate from yet. The build stage below generates, once the source is in.
RUN bun install --frozen-lockfile --ignore-scripts

FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bunx prisma generate
RUN bun --bun run build

FROM oven/bun:1.4.3 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["sh", "-c", "bunx prisma migrate deploy && bun --bun run start"]
