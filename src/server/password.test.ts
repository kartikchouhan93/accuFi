import { afterEach, describe, expect, it, vi } from "vitest"
import { hashPassword, verifyPassword } from "@/server/password"

afterEach(() => vi.restoreAllMocks())

describe("password hashing", () => {
  it("verifies a password against its own hash", async () => {
    const hash = await hashPassword("correct horse")
    expect(await verifyPassword("correct horse", hash)).toBe(true)
  })

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse")
    expect(await verifyPassword("battery staple", hash)).toBe(false)
  })

  it("produces a different hash for the same password each time", async () => {
    const [a, b] = await Promise.all([hashPassword("correct horse"), hashPassword("correct horse")])
    expect(a).not.toBe(b)
  })

  it("hashes with argon2id and does not contain the plaintext", async () => {
    const hash = await hashPassword("correct horse")
    expect(hash.startsWith("$argon2id$")).toBe(true)
    expect(hash).not.toContain("correct horse")
  })

  it("pins the work factor explicitly instead of inheriting the library's defaults", async () => {
    expect(await hashPassword("correct horse")).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
  })

  it("treats a malformed stored hash as a failed match, not an error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await verifyPassword("correct horse", "not-a-hash")).toBe(false)
    expect(await verifyPassword("correct horse", "")).toBe(false)
  })

  // verify() throws for a broken native binding exactly as it does for a malformed hash. Both answer "no" to the user,
  // who must not be told which; the operator, who would otherwise see only a login page that rejects everyone, is told.
  it("says so in the error log when verification throws, without the password or the hash in it, and still answers false", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const stored = "$argon2id$not-a-real-hash-but-secret-looking"
    expect(await verifyPassword("hunter2-not-for-logs", stored)).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    // An Error stringifies to {} in JSON, so read what it says.
    const printed = log.mock.calls.flat().map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(" ")
    expect(printed).toContain("verifyPassword")
    expect(printed).not.toContain("hunter2-not-for-logs")
    expect(printed).not.toContain(stored)
  })

  it("logs nothing for a wrong password or a right one: those are not faults", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const hash = await hashPassword("correct horse")
    expect(await verifyPassword("battery staple", hash)).toBe(false)
    expect(await verifyPassword("correct horse", hash)).toBe(true)
    expect(log).not.toHaveBeenCalled()
  })
})
