import { it, expect } from "vitest"

it("reports the database is reachable", async () => {
  const res = await fetch(`${process.env.APP_URL}/api/health`)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ status: "ok", database: "up" })
})
