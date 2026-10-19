import { describe, expect, it } from "vitest"
import { netWorth, type NodeBalance } from "./balance"

const asset = (nodeId: string, balance: bigint): NodeBalance => ({ nodeId, kind: "ASSET", balance })
const investment = (nodeId: string, balance: bigint): NodeBalance => ({ nodeId, kind: "INVESTMENT", balance })
// A liability balance is inflows minus outflows like every other (spec §4.2), so one the user owes on is NEGATIVE.
// That is what sumBalances returns; every figure fed in below is therefore <= 0, never the positive magnitude.
const liability = (nodeId: string, balance: bigint): NodeBalance => ({ nodeId, kind: "LIABILITY", balance })

describe("netWorth", () => {
  it("adds assets and investments and the (negative) liability balances, reporting the owed magnitude", () => {
    const nw = netWorth([
      { nodeId: "a", kind: "ASSET", balance: 5000000n },
      { nodeId: "i", kind: "INVESTMENT", balance: 7000000n },
      { nodeId: "l", kind: "LIABILITY", balance: -1500000n },
    ])
    expect(nw.assets).toBe(5000000n)
    expect(nw.investments).toBe(7000000n)
    expect(nw.liabilities).toBe(1500000n)
    expect(nw.total).toBe(10500000n)
    expect(nw.isPartial).toBe(false)
    expect(nw.unvaluedNodeIds).toEqual([])
  })

  it("sums several nodes of the same kind", () => {
    const nw = netWorth([asset("a1", 100n), asset("a2", 250n), liability("l1", -30n), liability("l2", -20n)])
    expect(nw.assets).toBe(350n)
    expect(nw.liabilities).toBe(50n)
    expect(nw.total).toBe(300n)
  })

  it("can be negative when liabilities exceed holdings", () => {
    expect(netWorth([asset("a", 100n), liability("l", -400n)]).total).toBe(-300n)
  })

  it("is reduced by spending on a credit card", () => {
    // The regression this file once could not see: a card spend is LIABILITY -> EXPENSE, an outflow from the card,
    // so the card's balance goes from 0 to -500. Net worth must fall by 500, not rise.
    const before = netWorth([asset("bank", 100000n), liability("card", 0n)])
    const after = netWorth([asset("bank", 100000n), liability("card", -50000n)])
    expect(after.total).toBe(before.total - 50000n)
    expect(after.liabilities).toBe(50000n)
  })

  it("is unchanged by borrowing, which adds an asset and a debt of the same size", () => {
    // Loan disbursed into the bank: LIABILITY -> ASSET.
    const before = netWorth([asset("bank", 100000n), liability("loan", 0n)])
    const after = netWorth([asset("bank", 1100000n), liability("loan", -1000000n)])
    expect(after.total).toBe(before.total)
    expect(after.liabilities).toBe(1000000n)
  })

  it("is unchanged by paying a card bill from the bank", () => {
    // ASSET -> LIABILITY moves 500 from the bank to the card: the debt shrinks by what the bank loses.
    const before = netWorth([asset("bank", 100000n), liability("card", -50000n)])
    const after = netWorth([asset("bank", 50000n), liability("card", 0n)])
    expect(after.total).toBe(before.total)
    expect(after.liabilities).toBe(0n)
  })

  it("treats a liability in credit (an overpaid card) as negative debt", () => {
    const nw = netWorth([asset("bank", 100n), liability("card", 30n)])
    expect(nw.liabilities).toBe(-30n)
    expect(nw.total).toBe(130n)
  })

  it("excludes income and expense totals from net worth", () => {
    const base = [asset("a", 5000000n), liability("l", -1500000n)]
    const withFlows = [
      ...base,
      { nodeId: "salary", kind: "INCOME_SOURCE" as const, balance: 9900000n },
      { nodeId: "food", kind: "EXPENSE" as const, balance: 400000n },
    ]
    expect(netWorth(withFlows)).toEqual(netWorth(base))
    expect(netWorth(withFlows).total).toBe(3500000n)
  })

  it("prefers a supplied valuation over the contribution balance", () => {
    const nw = netWorth([investment("i", 7000000n)], new Map([["i", 8500000n]]))
    expect(nw.investments).toBe(8500000n)
    expect(nw.total).toBe(8500000n)
    expect(nw.isPartial).toBe(false)
  })

  it("accepts a valuation of zero as a real value, not as missing", () => {
    const nw = netWorth([investment("i", 7000000n)], new Map([["i", 0n]]))
    expect(nw.investments).toBe(0n)
    expect(nw.isPartial).toBe(false)
    expect(nw.unvaluedNodeIds).toEqual([])
  })

  it("falls back to the contribution balance for an investment absent from the map", () => {
    const nw = netWorth(
      [investment("i", 7000000n), investment("j", 100n)],
      new Map([["j", 250n]]),
    )
    expect(nw.investments).toBe(7000250n)
    expect(nw.isPartial).toBe(false)
  })

  it("marks net worth partial and names nodes whose valuation is null", () => {
    const nw = netWorth(
      [asset("a", 5000000n), investment("i", 7000000n)],
      new Map<string, bigint | null>([["i", null]]),
    )
    expect(nw.isPartial).toBe(true)
    expect(nw.unvaluedNodeIds).toEqual(["i"])
  })

  it("excludes an unvalued investment from the total rather than counting it as zero or as cost", () => {
    const nw = netWorth(
      [asset("a", 5000000n), investment("i", 7000000n), liability("l", -1500000n)],
      new Map<string, bigint | null>([["i", null]]),
    )
    // Neither 5000000 + 7000000 - 1500000 (as cost) ...
    expect(nw.total).not.toBe(10500000n)
    // ... but only what can actually be valued: 5000000 - 1500000.
    expect(nw.investments).toBe(0n)
    expect(nw.total).toBe(3500000n)
  })

  it("keeps valued investments in the total while listing only the unvalued ones", () => {
    const nw = netWorth(
      [investment("good", 100n), investment("bad", 900n), investment("cost", 40n)],
      new Map<string, bigint | null>([
        ["good", 150n],
        ["bad", null],
      ]),
    )
    expect(nw.investments).toBe(190n)
    expect(nw.unvaluedNodeIds).toEqual(["bad"])
    expect(nw.isPartial).toBe(true)
  })

  it("ignores a null valuation for a node that is not an investment", () => {
    const nw = netWorth([asset("a", 100n)], new Map<string, bigint | null>([["a", null]]))
    expect(nw.assets).toBe(100n)
    expect(nw.isPartial).toBe(false)
    expect(nw.unvaluedNodeIds).toEqual([])
  })

  it("returns an all-zero, non-partial result for no nodes", () => {
    expect(netWorth([])).toEqual({
      assets: 0n,
      investments: 0n,
      liabilities: 0n,
      total: 0n,
      isPartial: false,
      unvaluedNodeIds: [],
    })
  })
})
