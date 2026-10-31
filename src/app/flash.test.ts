import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flashChannel } from "./flash"

// The message left for the next screen: read once, and on a channel of its own, so Recurring's never shows on Budgets.

function fakeStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

let storage: ReturnType<typeof fakeStorage>
beforeEach(() => {
  storage = fakeStorage()
  vi.stubGlobal("sessionStorage", storage)
})
afterEach(() => vi.unstubAllGlobals())

describe("a flash channel", () => {
  it("hands over what was left, once", () => {
    const { leaveFlash, takeFlash } = flashChannel("k")
    leaveFlash({ tone: "success", lines: ["Saved."] })
    expect(takeFlash()).toEqual({ tone: "success", lines: ["Saved."] })
    expect(takeFlash()).toBeNull()
  })

  it("keeps each channel's message apart from the others'", () => {
    const recurring = flashChannel("accufi:recurring-flash")
    const budgets = flashChannel("accufi:budgets-flash")
    recurring.leaveFlash({ tone: "success", lines: ["A rule."] })
    expect(budgets.takeFlash()).toBeNull()
    expect(recurring.takeFlash()).toEqual({ tone: "success", lines: ["A rule."] })
  })

  it("keeps the recurring screen's storage key as it was", async () => {
    const { leaveFlash } = await import("./recurring/flash")
    leaveFlash({ tone: "warning", lines: ["Reloaded."] })
    expect([...storage.data.keys()]).toEqual(["accufi:recurring-flash"])
  })

  it("gives the budgets screen a key of its own", async () => {
    const { leaveFlash } = await import("./budgets/flash")
    leaveFlash({ tone: "success", lines: ["Created."] })
    expect([...storage.data.keys()]).toEqual(["accufi:budgets-flash"])
  })

  it("ignores something that is not a message, and still clears it", () => {
    const { takeFlash } = flashChannel("k")
    storage.setItem("k", "not json")
    expect(takeFlash()).toBeNull()
    storage.setItem("k", JSON.stringify({ tone: "loud", lines: ["x"] }))
    expect(takeFlash()).toBeNull()
    expect(storage.data.has("k")).toBe(false)
  })

  it("says nothing, and does not throw, when storage is not there", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("blocked") },
      setItem: () => { throw new Error("blocked") },
      removeItem: () => { throw new Error("blocked") },
    })
    const { leaveFlash, takeFlash } = flashChannel("k")
    expect(() => leaveFlash({ tone: "success", lines: ["x"] })).not.toThrow()
    expect(takeFlash()).toBeNull()
  })
})
