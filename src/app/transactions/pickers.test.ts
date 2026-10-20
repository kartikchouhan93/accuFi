import { describe, expect, it } from "vitest"
import type { LedgerKind, SystemNodeRole } from "@/domain/ledger-kind"
import type { PickerNode } from "@/lib/transaction-list-view"
import { destinationChoices, groupByKind, groupSources, nodeLabel, sourceChoices } from "./pickers"

const node = (id: string, kind: LedgerKind, over: Partial<PickerNode> = {}): PickerNode => ({
  id,
  name: id,
  kind,
  archived: false,
  systemRole: null,
  ...over,
})
const system = (id: string, kind: LedgerKind, systemRole: SystemNodeRole) => node(id, kind, { systemRole })

const nodes = [
  node("salary", "INCOME_SOURCE"),
  node("freelance", "INCOME_SOURCE"),
  node("bank", "ASSET"),
  node("cash", "ASSET"),
  node("old", "ASSET", { archived: true }),
  node("card", "LIABILITY"),
  node("gold", "INVESTMENT"),
  node("food", "EXPENSE"),
  system("opening", "INCOME_SOURCE", "OPENING_BALANCE"),
  system("contra", "EXPENSE", "OPENING_BALANCE_CONTRA"),
  system("gain", "INCOME_SOURCE", "REALISED_GAIN"),
  system("loss", "EXPENSE", "REALISED_LOSS"),
]
const ids = (list: PickerNode[]) => list.map((n) => n.id)

describe("sourceChoices", () => {
  it("offers live nodes of every kind, and the two opening-balance nodes, but no archived node and no realised gain or loss", () => {
    expect(ids(sourceChoices(nodes))).toEqual(["salary", "freelance", "bank", "cash", "card", "gold", "food", "opening", "contra"])
  })

  it("keeps the nodes a transaction being edited already names, archived or system", () => {
    expect(ids(sourceChoices(nodes, ["old", "gain"]))).toEqual([
      "salary",
      "freelance",
      "bank",
      "cash",
      "old",
      "card",
      "gold",
      "food",
      "opening",
      "contra",
      "gain",
    ])
  })
})

describe("destinationChoices", () => {
  it("offers nothing until a source is chosen", () => {
    expect(destinationChoices(nodes, "")).toEqual([])
    expect(destinationChoices(nodes, "no-such-node")).toEqual([])
  })

  it("follows the flow rules from the source's kind, and never offers the source itself", () => {
    // INCOME_SOURCE pays into holdings and expenses, never into another income source.
    expect(ids(destinationChoices(nodes, "salary"))).toEqual(["bank", "cash", "card", "gold", "food"])
    expect(ids(destinationChoices(nodes, "bank"))).toEqual(["cash", "card", "gold", "food"])
    // A refund goes from an expense back to an account or a card, not to another expense or an income source.
    expect(ids(destinationChoices(nodes, "food"))).toEqual(["bank", "cash", "card"])
  })

  it("never offers a system node as a destination, the opening-balance contra included", () => {
    for (const source of ["salary", "bank", "card", "gold", "food", "opening"]) {
      const offered = ids(destinationChoices(nodes, source))
      for (const id of ["opening", "contra", "gain", "loss"]) expect(offered, `${source} -> ${id}`).not.toContain(id)
    }
  })

  it("lets an opening balance go only to an account or a card, where the node form puts one", () => {
    expect(ids(destinationChoices(nodes, "opening"))).toEqual(["bank", "cash", "card"])
    expect(ids(destinationChoices(nodes, "contra"))).toEqual(["bank", "cash", "card"])
  })

  it("lets an archived destination stay when the row being edited already has it and the flow is still legal", () => {
    expect(ids(destinationChoices(nodes, "bank", ["old"]))).toContain("old")
    expect(ids(destinationChoices(nodes, "salary", ["old"]))).toContain("old")
    expect(ids(destinationChoices(nodes, "food", ["old"]))).toContain("old")
    // Keeping a node is not allowing it: an archived income source is still never a destination.
    const withOldIncome = [...nodes, node("old-income", "INCOME_SOURCE", { archived: true })]
    expect(ids(destinationChoices(withOldIncome, "bank", ["old-income"]))).not.toContain("old-income")
  })

  it("keeps the contra node as the destination of the opening row being edited (an owed card or overdrawn account)", () => {
    expect(ids(destinationChoices(nodes, "bank", ["contra"]))).toContain("contra")
  })
})

describe("groupByKind", () => {
  it("groups in the ledger's order, skips empty kinds and sorts by name", () => {
    const groups = groupByKind([node("b", "EXPENSE"), node("a", "EXPENSE"), node("x", "ASSET")])
    expect(groups.map((g) => [g.label, ids(g.nodes)])).toEqual([
      ["Accounts", ["x"]],
      ["Expenses", ["a", "b"]],
    ])
  })
})

describe("groupSources", () => {
  it("puts the opening-balance nodes in their own Setup group, first, and keeps them out of the kind groups", () => {
    const groups = groupSources(sourceChoices(nodes))
    expect(groups.map((g) => [g.label, ids(g.nodes)])).toEqual([
      ["Setup", ["contra", "opening"]],
      ["Accounts", ["bank", "cash"]],
      ["Investments", ["gold"]],
      ["Liabilities", ["card"]],
      ["Income", ["freelance", "salary"]],
      ["Expenses", ["food"]],
    ])
  })

  it("has no Setup group when there is nothing for it", () => {
    expect(groupSources([node("bank", "ASSET")]).map((g) => g.label)).toEqual(["Accounts"])
  })
})

describe("nodeLabel", () => {
  it("says when a node is archived", () => {
    expect(nodeLabel(node("bank", "ASSET"))).toBe("bank")
    expect(nodeLabel(node("old", "ASSET", { archived: true }))).toBe("old (archived)")
  })
})
