import { describe, expect, it } from "vitest"
import { hashPassword, verifyPassword } from "@/server/password"

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

  it("treats a malformed stored hash as a failed match, not an error", async () => {
    expect(await verifyPassword("correct horse", "not-a-hash")).toBe(false)
    expect(await verifyPassword("correct horse", "")).toBe(false)
  })
})
