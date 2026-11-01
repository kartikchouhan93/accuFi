import { describe, expect, it } from "vitest"
import { calendarDate, type CalendarDate } from "./calendar-date"
import type { LedgerKind, SystemNodeRole } from "./ledger-kind"
import {
  DUPLICATE_WINDOW_DAYS,
  findDuplicate,
  indexByAmount,
  isLegalCounterpart,
  matchOccurrences,
  suggestFromRules,
  type ExistingTxn,
  type LearnedRule,
  type OccurrenceCandidate,
} from "./import-match"
import type { ImportDirection } from "./import-map"

const d = (s: string): CalendarDate => calendarDate(s)
const ACCOUNT = "acct"

const txn = (id: string, from: string, to: string, amountPaise: bigint, date: string): ExistingTxn => ({
  id,
  fromNodeId: from,
  toNodeId: to,
  amountPaise,
  occurredAt: d(date),
})

const row = (date: string, amountPaise: bigint, direction: ImportDirection) => ({
  occurredOn: d(date),
  amountPaise,
  direction,
})

describe("DUPLICATE_WINDOW_DAYS", () => {
  it("is three days either side", () => {
    expect(DUPLICATE_WINDOW_DAYS).toBe(3)
  })
})

describe("findDuplicate", () => {
  const out = row("2026-05-10", 150_000n, "OUT")

  it("matches at exactly 3 days and not at 4", () => {
    const at3 = txn("a", ACCOUNT, "X", 150_000n, "2026-05-13")
    const at4 = txn("b", ACCOUNT, "X", 150_000n, "2026-05-14")
    expect(findDuplicate(out, ACCOUNT, [at3])).toBe(at3)
    expect(findDuplicate(out, ACCOUNT, [at4])).toBeNull()
  })

  it("matches earlier dates within the window too", () => {
    const early = txn("a", ACCOUNT, "X", 150_000n, "2026-05-07")
    expect(findDuplicate(out, ACCOUNT, [early])).toBe(early)
    expect(findDuplicate(out, ACCOUNT, [txn("b", ACCOUNT, "X", 150_000n, "2026-05-06")])).toBeNull()
  })

  it("reads direction relative to the account", () => {
    const incoming = txn("a", "X", ACCOUNT, 150_000n, "2026-05-10")
    expect(findDuplicate(out, ACCOUNT, [incoming])).toBeNull()
    expect(findDuplicate(row("2026-05-10", 150_000n, "IN"), ACCOUNT, [incoming])).toBe(incoming)
    const outgoing = txn("b", ACCOUNT, "X", 150_000n, "2026-05-10")
    expect(findDuplicate(row("2026-05-10", 150_000n, "IN"), ACCOUNT, [outgoing])).toBeNull()
  })

  it("needs the exact amount", () => {
    expect(findDuplicate(out, ACCOUNT, [txn("a", ACCOUNT, "X", 150_001n, "2026-05-10")])).toBeNull()
    expect(findDuplicate(out, ACCOUNT, [txn("a", ACCOUNT, "X", 149_999n, "2026-05-10")])).toBeNull()
  })

  it("ignores another account's transactions", () => {
    expect(findDuplicate(out, ACCOUNT, [txn("a", "other", "X", 150_000n, "2026-05-10")])).toBeNull()
  })

  it("picks the closest by date", () => {
    const far = txn("a", ACCOUNT, "X", 150_000n, "2026-05-08")
    const near = txn("b", ACCOUNT, "X", 150_000n, "2026-05-11")
    expect(findDuplicate(out, ACCOUNT, [far, near])).toBe(near)
    expect(findDuplicate(out, ACCOUNT, [near, far])).toBe(near)
  })

  it("breaks an equal distance with the lower id, whatever the input order", () => {
    const low = txn("a", ACCOUNT, "X", 150_000n, "2026-05-08")
    const high = txn("b", ACCOUNT, "X", 150_000n, "2026-05-12")
    expect(findDuplicate(out, ACCOUNT, [high, low])).toBe(low)
    expect(findDuplicate(out, ACCOUNT, [low, high])).toBe(low)
  })

  it("crosses month and year boundaries", () => {
    const next = txn("a", ACCOUNT, "X", 150_000n, "2027-01-02")
    expect(findDuplicate(row("2026-12-30", 150_000n, "OUT"), ACCOUNT, [next])).toBe(next)
    expect(findDuplicate(row("2026-12-30", 150_000n, "OUT"), ACCOUNT, [txn("b", ACCOUNT, "X", 150_000n, "2027-01-03")])).toBeNull()
  })

  it("returns null for no candidates and does not mutate its input", () => {
    expect(findDuplicate(out, ACCOUNT, [])).toBeNull()
    const list = [
      txn("b", ACCOUNT, "X", 150_000n, "2026-05-12"),
      txn("a", ACCOUNT, "X", 150_000n, "2026-05-08"),
    ]
    const copy = [...list]
    findDuplicate(out, ACCOUNT, list)
    expect(list).toEqual(copy)
  })
})

describe("indexByAmount", () => {
  it("groups transactions by exact amount, keeping each bucket in the given order", () => {
    const a = txn("a", ACCOUNT, "X", 100n, "2026-05-10")
    const b = txn("b", ACCOUNT, "Y", 200n, "2026-05-10")
    const c = txn("c", "Z", ACCOUNT, 100n, "2026-05-11")
    const index = indexByAmount([a, b, c])
    expect(index.get(100n)).toEqual([a, c])
    expect(index.get(200n)).toEqual([b])
    expect(index.get(300n)).toBeUndefined()
  })

  it("gives findDuplicate the same answer through the amount's bucket as through the whole list", () => {
    const existing = [
      txn("a", ACCOUNT, "X", 150_000n, "2026-05-12"),
      txn("b", ACCOUNT, "X", 150_000n, "2026-05-11"),
      txn("c", ACCOUNT, "X", 90_000n, "2026-05-10"),
      txn("d", "X", ACCOUNT, 150_000n, "2026-05-10"),
      txn("e", ACCOUNT, "X", 150_001n, "2026-05-10"),
    ]
    const index = indexByAmount(existing)
    for (const probe of [
      row("2026-05-10", 150_000n, "OUT"),
      row("2026-05-10", 150_000n, "IN"),
      row("2026-05-10", 90_000n, "OUT"),
      row("2026-05-10", 1n, "OUT"),
    ]) {
      expect(findDuplicate(probe, ACCOUNT, index.get(probe.amountPaise) ?? [])).toEqual(findDuplicate(probe, ACCOUNT, existing))
    }
  })
})

describe("matchOccurrences", () => {
  const cand = (
    id: string,
    dueOn: string,
    amountPaise = 50_000n,
    direction: ImportDirection = "OUT",
  ): OccurrenceCandidate => ({
    occurrenceId: id,
    ruleName: `rule ${id}`,
    dueOn: d(dueOn),
    amountPaise,
    direction,
    otherNodeId: "X",
  })

  it("matches a candidate within the window with the same amount and direction", () => {
    const c = cand("o1", "2026-05-13")
    expect(matchOccurrences([row("2026-05-10", 50_000n, "OUT")], [c])).toEqual([c])
  })

  it("does not match at 4 days, another amount or the other direction", () => {
    expect(matchOccurrences([row("2026-05-10", 50_000n, "OUT")], [cand("o1", "2026-05-14")])).toEqual([null])
    expect(matchOccurrences([row("2026-05-10", 50_001n, "OUT")], [cand("o1", "2026-05-10")])).toEqual([null])
    expect(matchOccurrences([row("2026-05-10", 50_000n, "IN")], [cand("o1", "2026-05-10")])).toEqual([null])
    expect(matchOccurrences([row("2026-05-10", 50_000n, "OUT")], [cand("o1", "2026-05-10", 50_000n, "IN")])).toEqual([null])
  })

  it("gives one candidate to the closer of two rows", () => {
    const c = cand("o1", "2026-05-10")
    const result = matchOccurrences([row("2026-05-12", 50_000n, "OUT"), row("2026-05-11", 50_000n, "OUT")], [c])
    expect(result).toEqual([null, c])
  })

  it("breaks an equal distance by row order", () => {
    const c = cand("o1", "2026-05-10")
    const result = matchOccurrences([row("2026-05-11", 50_000n, "OUT"), row("2026-05-09", 50_000n, "OUT")], [c])
    expect(result).toEqual([c, null])
  })

  it("uses the closer of two candidates for a row", () => {
    const far = cand("o1", "2026-05-08")
    const near = cand("o2", "2026-05-11")
    expect(matchOccurrences([row("2026-05-10", 50_000n, "OUT")], [far, near])).toEqual([near])
  })

  it("assigns each candidate once across several rows", () => {
    const a = cand("o1", "2026-05-10")
    const b = cand("o2", "2026-05-12")
    const result = matchOccurrences(
      [row("2026-05-10", 50_000n, "OUT"), row("2026-05-11", 50_000n, "OUT")],
      [a, b],
    )
    expect(result).toEqual([a, b])
    expect(new Set(result).size).toBe(2)
  })

  it("returns an array as long as the rows, empty for none", () => {
    expect(matchOccurrences([], [cand("o1", "2026-05-10")])).toEqual([])
    expect(matchOccurrences([row("2026-05-10", 1n, "OUT"), row("2026-05-10", 2n, "IN")], [])).toEqual([null, null])
  })
})

describe("suggestFromRules", () => {
  const rule = (direction: ImportDirection, descriptionKey: string, nodeId: string): LearnedRule => ({
    direction,
    descriptionKey,
    nodeId,
  })

  it("prefers the exact key over a contained one", () => {
    const rules = [rule("OUT", "AMAZON", "contained"), rule("OUT", "AMAZON PAY", "exact")]
    expect(suggestFromRules("OUT", "AMAZON PAY", rules)).toBe("exact")
  })

  it("picks the longest contained key", () => {
    const rules = [rule("OUT", "AMAZON", "short"), rule("OUT", "AMAZON PAY", "long")]
    expect(suggestFromRules("OUT", "AMAZON PAY INDIA", rules)).toBe("long")
    expect(suggestFromRules("OUT", "AMAZON PAY INDIA", [...rules].reverse())).toBe("long")
  })

  it("matches whole tokens only", () => {
    expect(suggestFromRules("OUT", "AMAZONIA", [rule("OUT", "AMAZON", "n")])).toBeNull()
    expect(suggestFromRules("OUT", "PAY AMAZON NOW", [rule("OUT", "AMAZON", "n")])).toBe("n")
    expect(suggestFromRules("OUT", "XAMAZON PAY", [rule("OUT", "AMAZON PAY", "n")])).toBeNull()
  })

  it("ignores the other direction", () => {
    expect(suggestFromRules("OUT", "SALARY", [rule("IN", "SALARY", "n")])).toBeNull()
  })

  it("gives null for an empty key or no rules", () => {
    expect(suggestFromRules("OUT", "", [rule("OUT", "", "n")])).toBeNull()
    expect(suggestFromRules("OUT", "AMAZON", [])).toBeNull()
  })
})

describe("isLegalCounterpart", () => {
  const asset = { id: ACCOUNT, kind: "ASSET" as const }
  const card = { id: ACCOUNT, kind: "LIABILITY" as const }
  const node = (
    kind: LedgerKind,
    over: Partial<{ id: string; systemRole: SystemNodeRole | null; archived: boolean; heldByLots: boolean }> = {},
  ) => ({ id: "c1", kind, systemRole: null, archived: false, heldByLots: false, ...over })

  it("follows the flow table for an asset account going out", () => {
    expect(isLegalCounterpart(asset, "OUT", node("EXPENSE"))).toBe(true)
    expect(isLegalCounterpart(asset, "OUT", node("LIABILITY"))).toBe(true)
    expect(isLegalCounterpart(asset, "OUT", node("ASSET"))).toBe(true)
    expect(isLegalCounterpart(asset, "OUT", node("INCOME_SOURCE"))).toBe(false)
  })

  it("follows the flow table for an asset account coming in", () => {
    expect(isLegalCounterpart(asset, "IN", node("INCOME_SOURCE"))).toBe(true)
    expect(isLegalCounterpart(asset, "IN", node("ASSET"))).toBe(true)
    // The brief expected EXPENSE -> ASSET to be illegal, but spec 5 allows it (a refund), and the table decides.
    expect(isLegalCounterpart(asset, "IN", node("EXPENSE"))).toBe(true)
  })

  it("handles a card account", () => {
    expect(isLegalCounterpart(card, "OUT", node("EXPENSE"))).toBe(true)
    expect(isLegalCounterpart(card, "IN", node("ASSET"))).toBe(true)
    expect(isLegalCounterpart(card, "OUT", node("INCOME_SOURCE"))).toBe(false)
  })

  it("rejects archived, system-role, lot-held and self counterparts", () => {
    expect(isLegalCounterpart(asset, "OUT", node("EXPENSE", { archived: true }))).toBe(false)
    expect(isLegalCounterpart(asset, "OUT", node("EXPENSE", { systemRole: "OPENING_BALANCE" }))).toBe(false)
    expect(isLegalCounterpart(asset, "OUT", node("EXPENSE", { heldByLots: true }))).toBe(false)
    expect(isLegalCounterpart(asset, "OUT", node("ASSET", { id: ACCOUNT }))).toBe(false)
  })
})
