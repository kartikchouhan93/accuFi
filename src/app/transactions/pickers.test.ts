import { describe, expect, it } from "vitest"
import type { LedgerKind, SystemNodeRole } from "@/domain/ledger-kind"
import type { PickerNode } from "@/lib/transaction-list-view"
import { destinationChoices, groupByKind, groupWithSetup, heldByLots, legDestinationChoices, nodeLabel, sourceChoices } from "./pickers"

const node = (id: string, kind: LedgerKind, over: Partial<PickerNode> = {}): PickerNode => ({
  id,
  name: id,
  kind,
  archived: false,
  systemRole: null,
  valuationMode: null,
  unitLabel: null,
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
  it("offers live nodes of every kind and the Opening Balance node, but no archived node, no contra, no realised gain or loss", () => {
    expect(ids(sourceChoices(nodes))).toEqual(["salary", "freelance", "bank", "cash", "card", "gold", "food", "opening"])
  })

  it("keeps the nodes a transaction being edited already names, archived or system, in either position", () => {
    expect(ids(sourceChoices(nodes, ["old", "gain", "contra"]))).toEqual([
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
    // A refund goes from an expense back to an account or a card, not to another expense or an income source.
    expect(ids(destinationChoices(nodes, "food"))).toEqual(["bank", "cash", "card"])
  })

  it("offers the opening-balance contra, and only it among the system nodes, from an account or a card", () => {
    expect(ids(destinationChoices(nodes, "bank"))).toEqual(["cash", "card", "gold", "food", "contra"])
    expect(ids(destinationChoices(nodes, "card"))).toEqual(["bank", "cash", "gold", "food", "contra"])
    // Not from a source whose position is not a balance a user states up front.
    for (const source of ["salary", "gold", "food"]) expect(ids(destinationChoices(nodes, source)), source).not.toContain("contra")
  })

  it("lets Opening Balance go only to an account or a card, where the node form puts a positive opening", () => {
    expect(ids(destinationChoices(nodes, "opening"))).toEqual(["bank", "cash", "card"])
  })

  it("never offers the contra as a source or Opening Balance as a destination", () => {
    expect(destinationChoices(nodes, "contra")).toEqual([])
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

// The four system roles against both positions, in one table, so a later milestone cannot quietly widen what this form
// offers. Opening Balance is a source and the contra a destination because that is how an opening position is posted
// (spec "Opening position"); disposals (M2) post the realised nodes themselves.
describe("system nodes by position", () => {
  const roles: { role: SystemNodeRole; kind: LedgerKind; asSource: boolean; asDestination: boolean }[] = [
    { role: "OPENING_BALANCE", kind: "INCOME_SOURCE", asSource: true, asDestination: false },
    { role: "OPENING_BALANCE_CONTRA", kind: "EXPENSE", asSource: false, asDestination: true },
    { role: "REALISED_GAIN", kind: "INCOME_SOURCE", asSource: false, asDestination: false },
    { role: "REALISED_LOSS", kind: "EXPENSE", asSource: false, asDestination: false },
  ]
  it.each(roles)("$role: offered as a source is $asSource, as a destination is $asDestination", ({ role, kind, asSource, asDestination }) => {
    const target = system("target", kind, role)
    const world = [node("bank", "ASSET"), node("card", "LIABILITY"), target]
    expect(ids(sourceChoices(world)).includes("target")).toBe(asSource)
    // From an account and from a card, the two sources an opening position is entered against.
    expect(ids(destinationChoices(world, "bank")).includes("target")).toBe(asDestination)
    expect(ids(destinationChoices(world, "card")).includes("target")).toBe(asDestination)
  })

  it.each(roles)("$role is still offered where a row being edited already has it", ({ role, kind }) => {
    const target = system("target", kind, role)
    const world = [node("bank", "ASSET"), target]
    expect(ids(sourceChoices(world, ["target"]))).toContain("target")
    if (kind === "EXPENSE") expect(ids(destinationChoices(world, "bank", ["target"]))).toContain("target")
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

describe("groupWithSetup", () => {
  it("puts the opening-balance nodes in their own Setup group, first, and keeps them out of the kind groups", () => {
    const groups = groupWithSetup([...sourceChoices(nodes), system("contra", "EXPENSE", "OPENING_BALANCE_CONTRA")])
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
    expect(groupWithSetup([node("bank", "ASSET")]).map((g) => g.label)).toEqual(["Accounts"])
  })
})

describe("nodeLabel", () => {
  it("says when a node is archived", () => {
    expect(nodeLabel(node("bank", "ASSET"))).toBe("bank")
    expect(nodeLabel(node("old", "ASSET", { archived: true }))).toBe("old (archived)")
  })
})

describe("legDestinationChoices", () => {
  const investments = [
    node("bank", "ASSET"),
    node("food", "EXPENSE"),
    node("gold", "INVESTMENT", { valuationMode: "QUANTITY", unitLabel: "g" }),
    node("flat", "INVESTMENT", { valuationMode: "LUMP", unitLabel: "flat" }),
    node("ppf", "INVESTMENT", { valuationMode: "CONTRIBUTION_ONLY", unitLabel: "unit" }),
  ]

  it("leaves out the investments held by lots, which a split leg cannot buy (it carries no quantity)", () => {
    expect(ids(destinationChoices(investments, "bank"))).toEqual(["food", "gold", "flat", "ppf"])
    expect(ids(legDestinationChoices(investments, "bank"))).toEqual(["food", "ppf"])
  })

  it("still offers one the leg being edited already names", () => {
    expect(ids(legDestinationChoices(investments, "bank", ["gold"]))).toEqual(["food", "gold", "ppf"])
  })

  it("knows which nodes are held by lots: an investment valued by quantity or as a lump", () => {
    expect(investments.filter(heldByLots).map((n) => n.id)).toEqual(["gold", "flat"])
  })
})
