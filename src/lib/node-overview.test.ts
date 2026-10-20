import type { LedgerNode } from "@prisma/client"
import { describe, expect, it } from "vitest"
import type { NodeBalance } from "../domain/balance"
import { buildNodeOverview } from "./node-overview"

let sequence = 0
function node(kind: LedgerNode["kind"], name: string, over: Partial<LedgerNode> = {}): LedgerNode {
  sequence += 1
  return {
    id: `n${sequence}`,
    userId: "u1",
    kind,
    name,
    parentId: null,
    institution: null,
    lastFour: null,
    assetSubtype: null,
    liabilitySubtype: null,
    creditLimitPaise: null,
    statementDay: null,
    dueDay: null,
    valuationMode: null,
    unitLabel: null,
    lotMethod: null,
    stalePriceDays: null,
    blockNegative: false,
    systemRole: null,
    archivedAt: null,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    ...over,
  }
}
const balanceOf = (n: LedgerNode, balance: bigint): NodeBalance => ({ nodeId: n.id, kind: n.kind, balance, archived: n.archivedAt !== null })

describe("buildNodeOverview", () => {
  const bank = node("ASSET", "Bank")
  const oldBank = node("ASSET", "Old bank", { archivedAt: new Date("2026-05-01T00:00:00Z") })
  const card = node("LIABILITY", "Card")
  const oldCard = node("LIABILITY", "Old card", { archivedAt: new Date("2026-05-01T00:00:00Z") })
  const mf = node("INVESTMENT", "Fund", { creditLimitPaise: null })
  const nodes = [bank, oldBank, card, oldCard, mf]
  const balances = [
    balanceOf(bank, 1_000_000n),
    balanceOf(oldBank, 500_000n),
    balanceOf(card, -200_000n),
    balanceOf(oldCard, -300_000n),
    balanceOf(mf, 250_000n),
  ]

  it("counts archived nodes in every total, because hiding a row is the screen's business and not the arithmetic's", () => {
    const overview = buildNodeOverview(nodes, balances)
    expect(overview.kinds.ASSET).toEqual({ total: "1500000", archivedCount: 1 })
    expect(overview.kinds.LIABILITY).toEqual({ total: "-500000", archivedCount: 1 })
    expect(overview.netWorth).toEqual({ total: "1250000", assets: "1500000", investments: "250000", liabilities: "500000" })
  })

  it("does not let an archived card you still owe on raise net worth", () => {
    const before = buildNodeOverview(
      [bank, card, oldCard],
      [balanceOf(bank, 1_000_000n), balanceOf(card, -200_000n), balanceOf(oldCard, -300_000n)],
    )
    const unarchived = node("LIABILITY", "Old card", { id: oldCard.id })
    const after = buildNodeOverview(
      [bank, card, unarchived],
      [balanceOf(bank, 1_000_000n), balanceOf(card, -200_000n), balanceOf(unarchived, -300_000n)],
    )
    expect(before.netWorth.total).toBe(after.netWorth.total)
    expect(before.netWorth.total).toBe("500000")
  })

  it("reports a liability's magnitude owed as a positive figure the total already subtracted", () => {
    const only = buildNodeOverview([card], [balanceOf(card, -200_000n)])
    expect(only.netWorth).toMatchObject({ total: "-200000", liabilities: "200000" })
  })

  it("gives every node a balance, zero for a node with no movements", () => {
    const fresh = node("EXPENSE", "Fresh")
    const overview = buildNodeOverview([fresh], [])
    expect(overview.balances).toEqual({ [fresh.id]: "0" })
    expect(overview.kinds.EXPENSE).toEqual({ total: "0", archivedCount: 0 })
  })

  it("is plain data: it can be serialised to the browser", () => {
    const withLimit = node("LIABILITY", "Limit card", { creditLimitPaise: 9_007_199_254_740_993_099n })
    const overview = buildNodeOverview([withLimit], [balanceOf(withLimit, -1n)])
    expect(() => JSON.stringify(overview)).not.toThrow()
    expect(overview.nodes[0].creditLimitPaise).toBe("9007199254740993099")
  })

  it("lists every kind, including ones with no nodes", () => {
    expect(Object.keys(buildNodeOverview([], []).kinds).sort()).toEqual(
      ["ASSET", "EXPENSE", "INCOME_SOURCE", "INVESTMENT", "LIABILITY"],
    )
  })
})
