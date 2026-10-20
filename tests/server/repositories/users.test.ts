import { afterAll, describe, expect, it } from "vitest"
import { prisma } from "@/server/db"
import { findUserTimezone } from "@/server/repositories/user-repository"
import { createRegistry } from "./fixtures"

const registry = createRegistry()
afterAll(registry.cleanup)

describe("user repository", () => {
  it("reads the timezone of the user it is asked about, and only that user's", async () => {
    const a = await registry.makeUser()
    const b = await registry.makeUser()
    await prisma.user.update({ where: { id: b.id }, data: { timezone: "America/New_York" } })
    expect(await findUserTimezone(a.id)).toBe("Asia/Kolkata")
    expect(await findUserTimezone(b.id)).toBe("America/New_York")
  })

  it("returns null for a user that does not exist", async () => {
    expect(await findUserTimezone("no-such-user")).toBeNull()
  })
})
