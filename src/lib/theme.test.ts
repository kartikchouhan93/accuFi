import { describe, expect, it } from "vitest"
import { nextTheme, parseTheme, THEME_SCRIPT, THEME_STORAGE_KEY, type Theme } from "@/lib/theme"

describe("parseTheme", () => {
  it("accepts the two explicit choices", () => {
    expect(parseTheme("light")).toBe("light")
    expect(parseTheme("dark")).toBe("dark")
  })

  it("treats anything else as no choice, rather than trusting what was in storage", () => {
    for (const raw of [null, undefined, "", "system", "DARK", "blue", "<script>"]) expect(parseTheme(raw)).toBe("system")
  })
})

describe("nextTheme", () => {
  it("cycles system, light, dark, and back to system", () => {
    expect(nextTheme("system")).toBe("light")
    expect(nextTheme("light")).toBe("dark")
    expect(nextTheme("dark")).toBe("system")
  })

  it("returns to where it began after three steps, from any state", () => {
    for (const start of ["system", "light", "dark"] as Theme[]) expect(nextTheme(nextTheme(nextTheme(start)))).toBe(start)
  })
})

// The inline script is what stops a flash of the wrong theme, so it is run here as the browser would run it.
describe("THEME_SCRIPT", () => {
  function run(stored: () => string | null) {
    const root = { dataset: {} as Record<string, string> }
    new Function("localStorage", "document", THEME_SCRIPT)({ getItem: (key: string) => (key === THEME_STORAGE_KEY ? stored() : null) }, { documentElement: root })
    return root.dataset.theme
  }

  it("applies a stored choice of dark or light", () => {
    expect(run(() => "dark")).toBe("dark")
    expect(run(() => "light")).toBe("light")
  })

  it("applies nothing when there is no choice, or an unrecognised value", () => {
    expect(run(() => null)).toBeUndefined()
    expect(run(() => "system")).toBeUndefined()
    expect(run(() => "javascript:alert(1)")).toBeUndefined()
  })

  it("does not throw when storage is blocked", () => {
    expect(() =>
      run(() => {
        throw new Error("storage blocked")
      }),
    ).not.toThrow()
  })

  it("reads the same key the toggle writes", () => {
    expect(THEME_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY))
  })
})
