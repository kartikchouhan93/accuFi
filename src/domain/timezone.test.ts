import { describe, expect, it } from "vitest"
import { assertValidTimezone, DEFAULT_TIMEZONE, InvalidTimezoneError, isValidTimezone } from "@/domain/timezone"
import { todayIn } from "@/domain/calendar-date"

describe("isValidTimezone", () => {
  it.each(["Asia/Kolkata", "America/New_York", "Europe/London", "America/Argentina/Buenos_Aires", "UTC"])(
    "accepts the IANA zone %s",
    (zone) => {
      expect(isValidTimezone(zone)).toBe(true)
    },
  )

  it.each([
    ["a bogus zone", "Mars/Olympus_Mons"],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["a bare city", "Kolkata"],
    ["a UTC offset, which Intl accepts but is not an IANA zone", "+05:30"],
    ["an abbreviation", "IST"],
    ["a path-like string", "../../etc/passwd"],
    ["an oversized string", "A/".repeat(500)],
  ])("rejects %s", (_label, zone) => {
    expect(isValidTimezone(zone)).toBe(false)
  })

  it("rejects non-strings without throwing", () => {
    expect(isValidTimezone(undefined as unknown as string)).toBe(false)
    expect(isValidTimezone(null as unknown as string)).toBe(false)
    expect(isValidTimezone(42 as unknown as string)).toBe(false)
  })
})

describe("assertValidTimezone", () => {
  it("returns the zone it was given when valid", () => {
    expect(assertValidTimezone("Asia/Kolkata")).toBe("Asia/Kolkata")
  })

  it("throws a typed error, not Intl's RangeError, for an invalid zone", () => {
    expect(() => assertValidTimezone("Mars/Olympus_Mons")).toThrow(InvalidTimezoneError)
  })
})

describe("DEFAULT_TIMEZONE", () => {
  it("is itself valid and usable by todayIn", () => {
    expect(isValidTimezone(DEFAULT_TIMEZONE)).toBe(true)
    expect(() => todayIn(DEFAULT_TIMEZONE)).not.toThrow()
  })
})
