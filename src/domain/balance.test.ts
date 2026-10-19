import { describe, expect, it } from "vitest"
import { netWorth, type NodeBalance } from "./balance"

const asset = (nodeId: string, balance: bigint): NodeBalance => ({ nodeId, kind: "ASSET", balance })
const investment = (nodeId: string, balance: bigint): NodeBalance => ({ nodeId, kind: "INVESTMENT", balance })
const liability = (nodeId: string, balance: bigint): NodeBalance => ({ nodeId, kind: "LIABILITY", balance })

describe("netWorth", () => {
  it("sums assets and investments and subtracts liabilities", () => {
    const nw = netWorth([
      { nodeId: "a", kind: "ASSET", balance: 5000000n },
      { nodeId: "i", kind: "INVESTMENT", balance: 7000000n },
      { nodeId: "l", kind: "LIABILITY", balance: 1500000n },
    ])
    expect(nw.assets).toBe(5000000n)
    expect(nw.investments).toBe(7000000n)
    expect(nw.liabilities).toBe(1500000n)
    expect(nw.total).toBe(10500000n)
    expect(nw.isPartial).toBe(false)
    expect(nw.unvaluedNodeIds).toEqual([])
  })

  it("sums several nodes of the same kind", () => {
    const nw = netWorth([asset("a1", 100n), asset("a2", 250n), liability("l1", 30n), liability("l2", 20n)])
    expect(nw.assets).toBe(350n)
    expect(nw.liabilities).toBe(50n)
    expect(nw.total).toBe(300n)
  })

  it("can be negative when liabilities exceed holdings", () => {
    expect(netWorth([asset("a", 100n), liability("l", 400n)]).total).toBe(-300n)
  })

  it("excludes income and expense totals from net worth", () => {
    const base = [asset("a", 5000000n), liability("l", 1500000n)]
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
      [asset("a", 5000000n), investment("i", 7000000n), liability("l", 1500000n)],
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
