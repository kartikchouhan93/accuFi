import { describe, expect, it } from "vitest"
// Value import through the `@/` alias, so this suite fails if vitest cannot resolve it.
import { calendarDate } from "@/domain/calendar-date"
import {
  validateTransaction,
  type NodeSummary,
  type TransactionDraft,
} from "./transaction-rules"

const node = (id: string, kind: NodeSummary["kind"], archivedAt: Date | null = null): NodeSummary => ({
  id,
  kind,
  archivedAt,
  systemRole: null,
})

const draft = (over: Partial<TransactionDraft> = {}): TransactionDraft => ({
  fromNode: node("salary", "INCOME_SOURCE"),
  toNode: node("bank", "ASSET"),
  amount: 100_00n,
  occurredAt: calendarDate("2026-04-01"),
  ...over,
})

const codes = (d: TransactionDraft, opts?: { allowArchived?: boolean }) =>
  validateTransaction(d, opts).map((v) => v.code)

describe("validateTransaction", () => {
  it("accepts a legal, positive, non-archived transaction", () => {
    expect(validateTransaction(draft())).toEqual([])
  })

  it("rejects a transaction from a node to itself", () => {
    const bank = node("bank", "ASSET")
    expect(codes(draft({ fromNode: bank, toNode: bank }))).toEqual(["SAME_NODE"])
  })

  it("rejects a zero amount", () => {
    expect(codes(draft({ amount: 0n }))).toEqual(["NON_POSITIVE_AMOUNT"])
  })

  it("rejects a negative amount", () => {
    expect(codes(draft({ amount: -1n }))).toEqual(["NON_POSITIVE_AMOUNT"])
  })

  it("rejects an illegal kind pair naming both kinds in the message", () => {
    const violations = validateTransaction(
      draft({ fromNode: node("rent", "EXPENSE"), toNode: node("fund", "INVESTMENT") }),
    )
    expect(violations.map((v) => v.code)).toEqual(["ILLEGAL_FLOW"])
    expect(violations[0].message).toContain("EXPENSE")
    expect(violations[0].message).toContain("INVESTMENT")
  })

  it("rejects an archived node by default", () => {
    const archived = node("old-bank", "ASSET", new Date("2025-01-01T00:00:00Z"))
    expect(codes(draft({ toNode: archived }))).toEqual(["ARCHIVED_TARGET"])
    expect(codes(draft({ toNode: archived }), { allowArchived: false })).toEqual(["ARCHIVED_TARGET"])
  })

  it("flags an archived source node as well as an archived target", () => {
    const archived = node("old-job", "INCOME_SOURCE", new Date("2025-01-01T00:00:00Z"))
    // its own code, so a form can highlight the control that is wrong
    expect(codes(draft({ fromNode: archived }))).toEqual(["ARCHIVED_SOURCE"])
  })

  it("permits an archived node when allowArchived is set (EC-14)", () => {
    const archived = node("old-bank", "ASSET", new Date("2025-01-01T00:00:00Z"))
    expect(validateTransaction(draft({ toNode: archived }), { allowArchived: true })).toEqual([])
  })

  it("returns every applicable violation, not just the first", () => {
    const archived = node("old-bank", "ASSET", new Date("2025-01-01T00:00:00Z"))
    const result = codes(draft({ toNode: archived, amount: 0n }))
    expect(result).toHaveLength(2)
    expect(result).toEqual(expect.arrayContaining(["NON_POSITIVE_AMOUNT", "ARCHIVED_TARGET"]))
  })

  it("reports a same-node expense-to-expense transaction as both same-node and illegal", () => {
    const e = node("food", "EXPENSE")
    expect(codes(draft({ fromNode: e, toNode: e }))).toEqual(
      expect.arrayContaining(["SAME_NODE", "ILLEGAL_FLOW"]),
    )
  })

  it("still reports other violations when allowArchived is set", () => {
    const archived = node("old-bank", "ASSET", new Date("2025-01-01T00:00:00Z"))
    expect(codes(draft({ toNode: archived, amount: -5n }), { allowArchived: true })).toEqual([
      "NON_POSITIVE_AMOUNT",
    ])
  })
})
