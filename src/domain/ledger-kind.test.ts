import { describe, expect, it } from "vitest"
import { ALLOWED_FLOWS, isFlowAllowed, type LedgerKind } from "./ledger-kind"

// The 25 ordered pairs of spec §5, written out independently of ALLOWED_FLOWS so that a wrong
// table fails here. Rows are "from", columns are "to", in the spec's column order.
const MATRIX: ReadonlyArray<readonly [LedgerKind, LedgerKind, boolean]> = [
  ["INCOME_SOURCE", "INCOME_SOURCE", false],
  ["INCOME_SOURCE", "ASSET", true],
  ["INCOME_SOURCE", "INVESTMENT", true],
  ["INCOME_SOURCE", "EXPENSE", true],
  ["INCOME_SOURCE", "LIABILITY", true],

  ["ASSET", "INCOME_SOURCE", false],
  ["ASSET", "ASSET", true],
  ["ASSET", "INVESTMENT", true],
  ["ASSET", "EXPENSE", true],
  ["ASSET", "LIABILITY", true],

  ["INVESTMENT", "INCOME_SOURCE", false],
  ["INVESTMENT", "ASSET", true],
  ["INVESTMENT", "INVESTMENT", true],
  ["INVESTMENT", "EXPENSE", true],
  ["INVESTMENT", "LIABILITY", true],

  ["EXPENSE", "INCOME_SOURCE", false],
  ["EXPENSE", "ASSET", true],
  ["EXPENSE", "INVESTMENT", false],
  ["EXPENSE", "EXPENSE", false],
  ["EXPENSE", "LIABILITY", true],

  ["LIABILITY", "INCOME_SOURCE", false],
  ["LIABILITY", "ASSET", true],
  ["LIABILITY", "INVESTMENT", true],
  ["LIABILITY", "EXPENSE", true],
  ["LIABILITY", "LIABILITY", true],
]

const ALL_KINDS: LedgerKind[] = ["INCOME_SOURCE", "ASSET", "INVESTMENT", "EXPENSE", "LIABILITY"]

describe("flow legality matrix (spec §5)", () => {
  it("the expectation list itself covers every ordered pair exactly once, 18 allowed", () => {
    const keys = new Set(MATRIX.map(([f, t]) => `${f}>${t}`))
    expect(MATRIX).toHaveLength(25)
    expect(keys.size).toBe(25)
    expect(MATRIX.filter(([, , allowed]) => allowed)).toHaveLength(18)
  })

  it.each(MATRIX)("%s -> %s is allowed: %s", (from, to, allowed) => {
    expect(isFlowAllowed(from, to)).toBe(allowed)
  })

  it("ALLOWED_FLOWS holds exactly the 18 allowed pairs, each once", () => {
    const expected = MATRIX.filter(([, , allowed]) => allowed)
      .map(([f, t]) => `${f}>${t}`)
      .sort()
    const actual = ALLOWED_FLOWS.map(([f, t]) => `${f}>${t}`).sort()
    expect(actual).toEqual(expected)
  })

  it("permits income to reach assets, investments, expenses and liabilities", () => {
    expect(isFlowAllowed("INCOME_SOURCE", "ASSET")).toBe(true)
    expect(isFlowAllowed("INCOME_SOURCE", "INVESTMENT")).toBe(true)
    expect(isFlowAllowed("INCOME_SOURCE", "EXPENSE")).toBe(true) // TDS
    expect(isFlowAllowed("INCOME_SOURCE", "LIABILITY")).toBe(true)
  })

  it("never permits money to flow back into an income source", () => {
    for (const k of ALL_KINDS) expect(isFlowAllowed(k, "INCOME_SOURCE")).toBe(false)
  })

  it("permits an expense to refund only to an asset or a liability", () => {
    expect(isFlowAllowed("EXPENSE", "ASSET")).toBe(true)
    expect(isFlowAllowed("EXPENSE", "LIABILITY")).toBe(true)
    expect(isFlowAllowed("EXPENSE", "INVESTMENT")).toBe(false)
    expect(isFlowAllowed("EXPENSE", "EXPENSE")).toBe(false)
  })
})
