import { describe, expect, it } from "vitest"
import { deserialisePaise, serialisePaise } from "./serialise"

describe("serialisePaise / deserialisePaise", () => {
  it("round-trips bigint paise through a string, including beyond safe-integer range", () => {
    for (const p of [0n, 1n, -1n, 12345678n, 9007199254740993099n, -9007199254740993099n]) {
      expect(deserialisePaise(serialisePaise(p))).toBe(p)
    }
    expect(serialisePaise(12345678n)).toBe("12345678")
  })
  it("rejects non-integral input", () => {
    for (const bad of ["", " ", "1.5", "1e3", "0x10", "abc", "12 ", "+5", "--1", "1,000"]) {
      expect(() => deserialisePaise(bad), JSON.stringify(bad)).toThrow()
    }
  })
})
