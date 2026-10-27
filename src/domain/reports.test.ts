import { describe, expect, it } from "vitest"
import { calendarDate } from "./calendar-date"
import type { Bucket } from "./periods"
import {
  cashFlow,
  flowOf,
  isReportable,
  portfolioPoint,
  rankFlows,
  shareTenths,
  stepBalances,
  type FlowNode,
  type Move,
} from "./reports"

const bucket = (key: string, from: string, to: string): Bucket => ({
  key,
  from: calendarDate(from),
  to: calendarDate(to),
  partial: false,
})
const months = [
  bucket("2026-01", "2026-01-01", "2026-01-31"),
  bucket("2026-02", "2026-02-01", "2026-02-28"),
  bucket("2026-03", "2026-03-01", "2026-03-31"),
]

const node = (
  id: string,
  name: string,
  kind: FlowNode["kind"],
  extra: Partial<FlowNode> = {},
): FlowNode => ({ id, name, kind, parentId: null, systemRole: null, archived: false, ...extra })

const nodes: FlowNode[] = [
  node("rent", "Rent", "EXPENSE"),
  node("food", "Food", "EXPENSE"),
  node("groceries", "Groceries", "EXPENSE", { parentId: "food" }),
  node("dining", "Dining", "EXPENSE"),
  node("loss", "Realised Loss", "EXPENSE", { systemRole: "REALISED_LOSS" }),
  node("contra", "Opening Balance Contra", "EXPENSE", { systemRole: "OPENING_BALANCE_CONTRA" }),
  node("salary", "Salary", "INCOME_SOURCE"),
  node("interest", "Interest", "INCOME_SOURCE"),
  node("gain", "Realised Gain", "INCOME_SOURCE", { systemRole: "REALISED_GAIN" }),
  node("opening", "Opening Balance", "INCOME_SOURCE", { systemRole: "OPENING_BALANCE" }),
]

const mv = (nodeId: string, bucketKey: string, inPaise: bigint, outPaise: bigint): Move => ({
  nodeId,
  bucket: bucketKey,
  inPaise,
  outPaise,
})

describe("isReportable", () => {
  it("is false for the opening-balance pair and true for everything else", () => {
    expect(isReportable({ systemRole: "OPENING_BALANCE" })).toBe(false)
    expect(isReportable({ systemRole: "OPENING_BALANCE_CONTRA" })).toBe(false)
    expect(isReportable({ systemRole: null })).toBe(true)
    expect(isReportable({ systemRole: "REALISED_GAIN" })).toBe(true)
    expect(isReportable({ systemRole: "REALISED_LOSS" })).toBe(true)
  })
})

describe("flowOf", () => {
  it("spending is in minus out, income is out minus in", () => {
    expect(flowOf("EXPENSE", { inPaise: 250000n, outPaise: 50000n })).toBe(200000n)
    expect(flowOf("INCOME_SOURCE", { inPaise: 0n, outPaise: 5000000n })).toBe(5000000n)
  })
})

describe("cashFlow", () => {
  const moves: Move[] = [
    mv("salary", "2026-01", 0n, 5000000n),
    mv("salary", "2026-02", 0n, 5000000n),
    mv("salary", "2026-03", 0n, 5000000n),
    mv("interest", "2026-02", 0n, 30000n),
    mv("gain", "2026-03", 0n, 200000n),
    mv("opening", "2026-01", 0n, 10000000n),
    mv("groceries", "2026-01", 400000n, 0n),
    mv("food", "2026-01", 100000n, 0n),
    mv("dining", "2026-01", 150000n, 0n),
    mv("rent", "2026-01", 1500000n, 0n),
    mv("contra", "2026-01", 2000000n, 0n),
    mv("groceries", "2026-02", 250000n, 50000n),
    mv("rent", "2026-02", 1500000n, 0n),
    mv("rent", "2026-03", 1500000n, 0n),
    mv("dining", "2026-03", 600000n, 900000n),
    mv("loss", "2026-03", 80000n, 0n),
  ]

  it("adds income, spending and saved per bucket and over the range, leaving the opening pair out", () => {
    const result = cashFlow(months, nodes, moves)
    expect(result.buckets.map((b) => b.bucket.key)).toEqual(["2026-01", "2026-02", "2026-03"])
    expect(result.buckets.map((b) => b.incomePaise)).toEqual([5000000n, 5030000n, 5200000n])
    expect(result.buckets.map((b) => b.spendingPaise)).toEqual([2150000n, 1700000n, 1280000n])
    expect(result.buckets.map((b) => b.savedPaise)).toEqual([2850000n, 3330000n, 3920000n])
    expect(result.incomePaise).toBe(15230000n)
    expect(result.spendingPaise).toBe(5130000n)
    expect(result.savedPaise).toBe(10100000n)
    expect(result.gainPaise).toBe(200000n)
    expect(result.lossPaise).toBe(80000n)
  })

  it("ignores a move whose bucket is not in the list", () => {
    const result = cashFlow(months, nodes, [...moves, mv("rent", "2026-04", 999n, 0n), mv("salary", "2025-12", 0n, 999n)])
    expect(result.incomePaise).toBe(15230000n)
    expect(result.spendingPaise).toBe(5130000n)
  })

  it("is all zeros with no moves", () => {
    const result = cashFlow(months, nodes, [])
    expect(result.buckets).toHaveLength(3)
    expect(result.incomePaise).toBe(0n)
    expect(result.spendingPaise).toBe(0n)
    expect(result.savedPaise).toBe(0n)
    expect(result.gainPaise).toBe(0n)
    expect(result.lossPaise).toBe(0n)
  })
})

describe("rankFlows (spending)", () => {
  const moves: Move[] = [
    mv("rent", "all", 4500000n, 0n),
    mv("food", "all", 100000n, 0n),
    mv("groceries", "all", 650000n, 50000n),
    mv("dining", "all", 750000n, 900000n),
    mv("loss", "all", 80000n, 0n),
    mv("contra", "all", 2000000n, 0n),
  ]

  it("rolls children into parents, orders by amount, sets refunds aside and shares the positive rows", () => {
    const ranked = rankFlows("EXPENSE", nodes, moves)
    expect(ranked.rows.map((r) => r.name)).toEqual(["Rent", "Food", "Realised Loss"])
    const [rent, food, loss] = ranked.rows
    expect(rent.paise).toBe(4500000n)
    expect(rent.shareTenths).toBe(852n)
    expect(food.paise).toBe(700000n)
    expect(food.directPaise).toBe(100000n)
    expect(food.shareTenths).toBe(133n)
    expect(food.children).toHaveLength(1)
    expect(food.children[0].name).toBe("Groceries")
    expect(food.children[0].paise).toBe(600000n)
    expect(loss.paise).toBe(80000n)
    expect(loss.shareTenths).toBe(15n)
    expect(loss.fromSales).toBe(true)
    expect(rent.fromSales).toBe(false)
    expect(ranked.refunds).toHaveLength(1)
    expect(ranked.refunds[0].name).toBe("Dining")
    expect(ranked.refunds[0].paise).toBe(-150000n)
    expect(ranked.refunds[0].shareTenths).toBeNull()
    expect(ranked.totalPaise).toBe(5130000n)
    expect(ranked.rows.concat(ranked.refunds).some((r) => r.id === "contra")).toBe(false)
  })

  it("flags an archived child but still counts it", () => {
    const withArchived = nodes.map((n) => (n.id === "groceries" ? { ...n, archived: true } : n))
    const ranked = rankFlows("EXPENSE", withArchived, moves)
    const food = ranked.rows.find((r) => r.id === "food")!
    expect(food.paise).toBe(700000n)
    expect(food.children[0].archived).toBe(true)
  })

  it("treats a child whose parent is not in the list as a top-level row", () => {
    const orphan = [node("snacks", "Snacks", "EXPENSE", { parentId: "ghost" })]
    const ranked = rankFlows("EXPENSE", orphan, [mv("snacks", "all", 300n, 0n)])
    expect(ranked.rows.map((r) => r.id)).toEqual(["snacks"])
  })

  it("treats a child whose parent is of the other kind as a top-level row", () => {
    const mixed = [node("salary", "Salary", "INCOME_SOURCE"), node("bonus", "Bonus", "EXPENSE", { parentId: "salary" })]
    const ranked = rankFlows("EXPENSE", mixed, [mv("bonus", "all", 300n, 0n), mv("salary", "all", 0n, 9000n)])
    expect(ranked.rows.map((r) => r.id)).toEqual(["bonus"])
    expect(ranked.totalPaise).toBe(300n)
  })

  it("lists a refund-only child inside a positive parent with its negative amount, lowering the parent", () => {
    const tree = [
      node("food", "Food", "EXPENSE"),
      node("groceries", "Groceries", "EXPENSE", { parentId: "food" }),
      node("dining", "Dining", "EXPENSE", { parentId: "food" }),
    ]
    const ranked = rankFlows("EXPENSE", tree, [
      mv("groceries", "all", 1000n, 0n),
      mv("dining", "all", 0n, 300n),
    ])
    expect(ranked.refunds).toEqual([])
    const [food] = ranked.rows
    expect(food.paise).toBe(700n)
    expect(food.children.map((c) => [c.id, c.paise])).toEqual([
      ["groceries", 1000n],
      ["dining", -300n],
    ])
  })

  it("gives children no share, while the top-level row keeps its own", () => {
    const tree = [
      node("food", "Food", "EXPENSE"),
      node("groceries", "Groceries", "EXPENSE", { parentId: "food" }),
      node("dining", "Dining", "EXPENSE", { parentId: "food" }),
      node("fuel", "Fuel", "EXPENSE"),
      node("petrol", "Petrol", "EXPENSE", { parentId: "fuel" }),
      node("cab", "Cab", "EXPENSE", { parentId: "fuel" }),
    ]
    const ranked = rankFlows("EXPENSE", tree, [
      mv("groceries", "all", 1000n, 0n),
      mv("dining", "all", 0n, 300n),
      mv("petrol", "all", 0n, 500n),
      mv("cab", "all", 0n, 100n),
    ])
    const [food] = ranked.rows
    expect(food.shareTenths).toBe(1000n)
    expect(food.children.map((c) => c.shareTenths)).toEqual([null, null])
    const [fuel] = ranked.refunds
    expect(fuel.id).toBe("fuel")
    expect(fuel.shareTenths).toBeNull()
    expect(fuel.children.map((c) => c.shareTenths)).toEqual([null, null])
  })

  it("gives a parent with children but no direct moves a direct amount of zero", () => {
    const tree = [node("food", "Food", "EXPENSE"), node("groceries", "Groceries", "EXPENSE", { parentId: "food" })]
    const ranked = rankFlows("EXPENSE", tree, [mv("groceries", "all", 500n, 0n)])
    expect(ranked.rows).toHaveLength(1)
    expect(ranked.rows[0].id).toBe("food")
    expect(ranked.rows[0].directPaise).toBe(0n)
    expect(ranked.rows[0].paise).toBe(500n)
  })

  it("keeps a node with moves that net to zero, and omits a node without moves", () => {
    const tree = [node("a", "A", "EXPENSE"), node("b", "B", "EXPENSE")]
    const ranked = rankFlows("EXPENSE", tree, [mv("a", "all", 100n, 100n)])
    expect(ranked.rows.map((r) => r.id)).toEqual(["a"])
    expect(ranked.rows[0].paise).toBe(0n)
    expect(ranked.refunds).toEqual([])
  })

  it("orders equal amounts by name then id", () => {
    const tree = [
      node("z1", "Same", "EXPENSE"),
      node("a1", "Same", "EXPENSE"),
      node("m1", "Alpha", "EXPENSE"),
    ]
    const ranked = rankFlows("EXPENSE", tree, [
      mv("z1", "all", 100n, 0n),
      mv("a1", "all", 100n, 0n),
      mv("m1", "all", 100n, 0n),
    ])
    expect(ranked.rows.map((r) => r.id)).toEqual(["m1", "a1", "z1"])
  })

  it("orders refunds most negative first", () => {
    const tree = [node("a", "A", "EXPENSE"), node("b", "B", "EXPENSE")]
    const ranked = rankFlows("EXPENSE", tree, [mv("a", "all", 0n, 100n), mv("b", "all", 0n, 900n)])
    expect(ranked.refunds.map((r) => r.id)).toEqual(["b", "a"])
    expect(ranked.rows).toEqual([])
    expect(ranked.totalPaise).toBe(-1000n)
  })

  it("is empty, with no share and no division by zero, when there is nothing to rank", () => {
    const ranked = rankFlows("EXPENSE", nodes, [])
    expect(ranked).toEqual({ rows: [], refunds: [], totalPaise: 0n })
  })

  it("gives no share when only refunds exist", () => {
    const tree = [node("a", "A", "EXPENSE")]
    const ranked = rankFlows("EXPENSE", tree, [mv("a", "all", 0n, 100n)])
    expect(ranked.rows).toEqual([])
    expect(ranked.refunds[0].shareTenths).toBeNull()
  })
})

describe("rankFlows (income)", () => {
  it("ranks sources by amount, keeps realised gains, leaves the opening balance out, and the shares add to 1000", () => {
    const ranked = rankFlows("INCOME_SOURCE", nodes, [
      mv("salary", "all", 0n, 15000000n),
      mv("interest", "all", 0n, 30000n),
      mv("gain", "all", 0n, 200000n),
      mv("opening", "all", 0n, 10000000n),
    ])
    expect(ranked.rows.map((r) => [r.name, r.paise, r.shareTenths])).toEqual([
      ["Salary", 15000000n, 985n],
      ["Realised Gain", 200000n, 13n],
      ["Interest", 30000n, 2n],
    ])
    expect(ranked.rows[1].fromSales).toBe(true)
    expect(ranked.totalPaise).toBe(15230000n)
    expect(ranked.rows.reduce((sum, r) => sum + (r.shareTenths ?? 0n), 0n)).toBe(1000n)
    expect(ranked.refunds).toEqual([])
  })
})

describe("shareTenths", () => {
  it("rounds half up to a tenth of a percent", () => {
    expect(shareTenths(1n, 8n)).toBe(125n)
    expect(shareTenths(1n, 3n)).toBe(333n)
    expect(shareTenths(1n, 6n)).toBe(167n)
    expect(shareTenths(1n, 16n)).toBe(63n)
  })

  it("is null when the whole is not positive or the part is negative", () => {
    expect(shareTenths(5n, 0n)).toBeNull()
    expect(shareTenths(5n, -3n)).toBeNull()
    expect(shareTenths(-1n, 5n)).toBeNull()
  })

  it("is exact for amounts far beyond Number precision", () => {
    expect(shareTenths(2n ** 60n, 2n ** 61n)).toBe(500n)
    expect(shareTenths(7n * 10n ** 24n, 9n * 10n ** 24n)).toBe(778n)
  })
})

describe("stepBalances", () => {
  it("opens each bucket on the previous closing", () => {
    const steps = stepBalances(months, new Map([["bank", 0n]]), [
      mv("bank", "2026-01", 15000000n, 2650000n),
      mv("bank", "2026-02", 5080000n, 2500000n),
      mv("bank", "2026-03", 6100000n, 2180000n),
    ])
    expect(steps.get("2026-01")!.get("bank")).toEqual({
      openingPaise: 0n,
      inPaise: 15000000n,
      outPaise: 2650000n,
      closingPaise: 12350000n,
    })
    expect(steps.get("2026-02")!.get("bank")).toEqual({
      openingPaise: 12350000n,
      inPaise: 5080000n,
      outPaise: 2500000n,
      closingPaise: 14930000n,
    })
    expect(steps.get("2026-03")!.get("bank")).toEqual({
      openingPaise: 14930000n,
      inPaise: 6100000n,
      outPaise: 2180000n,
      closingPaise: 18850000n,
    })
  })

  it("carries a node that has only an opening through every bucket", () => {
    const steps = stepBalances(months, new Map([["cash", 700n]]), [])
    for (const key of ["2026-01", "2026-02", "2026-03"]) {
      expect(steps.get(key)!.get("cash")).toEqual({ openingPaise: 700n, inPaise: 0n, outPaise: 0n, closingPaise: 700n })
    }
  })

  it("carries a negative opening", () => {
    const steps = stepBalances(months, new Map([["card", -2000000n]]), [mv("card", "2026-02", 0n, 500n)])
    expect(steps.get("2026-01")!.get("card")!.closingPaise).toBe(-2000000n)
    expect(steps.get("2026-02")!.get("card")).toEqual({
      openingPaise: -2000000n,
      inPaise: 0n,
      outPaise: 500n,
      closingPaise: -2000500n,
    })
    expect(steps.get("2026-03")!.get("card")!.openingPaise).toBe(-2000500n)
  })

  it("starts at zero for a node that has moves but no opening, in every bucket", () => {
    const steps = stepBalances(months, new Map(), [mv("fund", "2026-02", 900n, 0n)])
    expect(steps.get("2026-01")!.get("fund")).toEqual({ openingPaise: 0n, inPaise: 0n, outPaise: 0n, closingPaise: 0n })
    expect(steps.get("2026-02")!.get("fund")!.closingPaise).toBe(900n)
    expect(steps.get("2026-03")!.get("fund")!.openingPaise).toBe(900n)
  })

  it("adds several moves of one node in one bucket", () => {
    const steps = stepBalances(months, new Map(), [mv("bank", "2026-01", 100n, 0n), mv("bank", "2026-01", 50n, 20n)])
    expect(steps.get("2026-01")!.get("bank")).toEqual({ openingPaise: 0n, inPaise: 150n, outPaise: 20n, closingPaise: 130n })
  })
})

describe("portfolioPoint", () => {
  it("leaves an unvalued node out of value and gain but counts its cost in invested", () => {
    const point = portfolioPoint([
      { nodeId: "gold", investedPaise: 7000000n, valuePaise: null, stale: false },
      { nodeId: "fund", investedPaise: 1000000n, valuePaise: 1000000n, stale: false },
    ])
    expect(point.investedPaise).toBe(8000000n)
    expect(point.valuePaise).toBe(1000000n)
    expect(point.gainPaise).toBe(0n)
    expect(point.covered).toBe(1)
    expect(point.total).toBe(2)
    expect(point.unvaluedNodeIds).toEqual(["gold"])
    expect(point.stale).toBe(false)
  })

  it("computes the gain over valued nodes", () => {
    const point = portfolioPoint([
      { nodeId: "gold", investedPaise: 5100000n, valuePaise: 5320000n, stale: false },
      { nodeId: "fund", investedPaise: 1000000n, valuePaise: 1000000n, stale: false },
    ])
    expect(point.investedPaise).toBe(6100000n)
    expect(point.valuePaise).toBe(6320000n)
    expect(point.gainPaise).toBe(220000n)
    expect(point.covered).toBe(2)
    expect(point.unvaluedNodeIds).toEqual([])
  })

  it("is stale when any valued node is stale, but not when only an unvalued one is", () => {
    expect(
      portfolioPoint([
        { nodeId: "gold", investedPaise: 100n, valuePaise: 120n, stale: true },
        { nodeId: "fund", investedPaise: 100n, valuePaise: 100n, stale: false },
      ]).stale,
    ).toBe(true)
    expect(portfolioPoint([{ nodeId: "gold", investedPaise: 100n, valuePaise: null, stale: true }]).stale).toBe(false)
  })

  it("is all zeros for an empty list", () => {
    expect(portfolioPoint([])).toEqual({
      investedPaise: 0n,
      valuePaise: 0n,
      gainPaise: 0n,
      covered: 0,
      total: 0,
      unvaluedNodeIds: [],
      stale: false,
    })
  })
})
