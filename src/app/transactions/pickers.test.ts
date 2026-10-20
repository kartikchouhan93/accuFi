import { describe, expect, it } from "vitest"
import type { LedgerKind } from "@/domain/ledger-kind"
import type { PickerNode } from "@/lib/transaction-list-view"
import { destinationChoices, groupByKind, nodeLabel, sourceChoices } from "./pickers"

const node = (id: string, kind: LedgerKind, over: Partial<PickerNode> = {}): PickerNode => ({
  id,
  name: id,
  kind,
  archived: false,
  system: false,
  ...over,
})

const nodes = [
  node("salary", "INCOME_SOURCE"),
  node("freelance", "INCOME_SOURCE"),
  node("bank", "ASSET"),
  node("cash", "ASSET"),
  node("old", "ASSET", { archived: true }),
  node("card", "LIABILITY"),
  node("gold", "INVESTMENT"),
  node("food", "EXPENSE"),
  node("opening", "INCOME_SOURCE", { system: true }),
  node("contra", "EXPENSE", { system: true }),
]
const ids = (list: PickerNode[]) => list.map((n) => n.id)

describe("sourceChoices", () => {
  it("offers live nodes of every kind and neither archived nor system ones", () => {
    expect(ids(sourceChoices(nodes))).toEqual(["salary", "freelance", "bank", "cash", "card", "gold", "food"])
  })

  it("keeps the nodes a transaction being edited already names, archived or system", () => {
    expect(ids(sourceChoices(nodes, ["old", "opening"]))).toEqual(["salary", "freelance", "bank", "cash", "old", "card", "gold", "food", "opening"])
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

  it("lets an archived destination stay when the row being edited already has it and the flow is still legal", () => {
    expect(ids(destinationChoices(nodes, "bank", ["old"]))).toContain("old")
    expect(ids(destinationChoices(nodes, "salary", ["old"]))).toContain("old")
    expect(ids(destinationChoices(nodes, "food", ["old"]))).toContain("old")
    // Keeping a node is not allowing it: an archived income source is still never a destination.
    const withOldIncome = [...nodes, node("old-income", "INCOME_SOURCE", { archived: true })]
    expect(ids(destinationChoices(withOldIncome, "bank", ["old-income"]))).not.toContain("old-income")
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

describe("nodeLabel", () => {
  it("says when a node is archived", () => {
    expect(nodeLabel(node("bank", "ASSET"))).toBe("bank")
    expect(nodeLabel(node("old", "ASSET", { archived: true }))).toBe("old (archived)")
  })
})
