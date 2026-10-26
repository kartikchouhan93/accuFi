import { isFlowAllowed, type LedgerKind, type SystemNodeRole } from "@/domain/ledger-kind"
import { KIND_COPY, KIND_ORDER } from "@/lib/node-kinds"
import type { PickerNode } from "@/lib/transaction-list-view"

// Which nodes the form offers. A new entry may use any live node of the user's own; archived nodes (EC-14) are never
// offered. The application's own system nodes are not offered either, except the two that carry an opening position
// (spec "Opening position"), which are mirror images, so a user who forgot one can record it later (EC-36):
//   - Opening Balance (an income source) is a SOURCE only: a positive opening posts Opening Balance -> account or card.
//   - Opening Balance Contra (an expense) is a DESTINATION only: a negative opening, a card already owed on or an
//     overdrawn account, posts account or card -> Opening Balance Contra.
// Realised gain and loss belong to disposals (M2), which post them themselves; they are never offered in either position.
// A transaction being edited is the other exception: the nodes it already names stay on offer however they are classed,
// in either position, so a historical row that points at an archived account, or at a system node, can still be corrected.
// `keep` is those ids.
//
// The destinations are what the flow rules (spec §5, `isFlowAllowed`) permit from the chosen source, and never the
// source itself. The server checks all of this again; the picker only stops the user being offered what would be refused.

// What an opening position goes to or comes from: the node form's own rule (a node that holds a balance a user can state up front).
const OPENING_KINDS: ReadonlySet<LedgerKind> = new Set(["ASSET", "LIABILITY"])

const hasRole = (node: PickerNode, role: SystemNodeRole) => node.systemRole === role
const isOpening = (node: PickerNode) => hasRole(node, "OPENING_BALANCE") || hasRole(node, "OPENING_BALANCE_CONTRA")
const isOrdinary = (node: PickerNode) => !node.archived && node.systemRole === null

export const sourceChoices = (nodes: readonly PickerNode[], keep: readonly string[] = []): PickerNode[] =>
  nodes.filter((node) => keep.includes(node.id) || isOrdinary(node) || (!node.archived && hasRole(node, "OPENING_BALANCE")))

export function destinationChoices(nodes: readonly PickerNode[], sourceId: string, keep: readonly string[] = []): PickerNode[] {
  const source = nodes.find((node) => node.id === sourceId)
  if (!source || hasRole(source, "OPENING_BALANCE_CONTRA")) return []
  return nodes.filter((node) => {
    if (node.id === source.id || !isFlowAllowed(source.kind, node.kind)) return false
    if (keep.includes(node.id)) return true
    // Opening Balance goes only to an account or a card; the contra comes only from one.
    if (hasRole(source, "OPENING_BALANCE")) return isOrdinary(node) && OPENING_KINDS.has(node.kind)
    if (!node.archived && hasRole(node, "OPENING_BALANCE_CONTRA")) return OPENING_KINDS.has(source.kind)
    return isOrdinary(node)
  })
}

/** An investment valued by quantity or as a lump: what it holds is its lots, so each purchase of it carries a quantity. */
export const heldByLots = (node: PickerNode): boolean =>
  node.kind === "INVESTMENT" && (node.valuationMode === "QUANTITY" || node.valuationMode === "LUMP")

/**
 * The destinations a leg of a split may have: those of a single entry, less the investments held by lots. A split carries
 * no quantity, so the server refuses a leg into one (a purchase of it is entered on its own). A node the leg being edited
 * already names stays on offer, as everywhere.
 */
export const legDestinationChoices = (nodes: readonly PickerNode[], sourceId: string, keep: readonly string[] = []): PickerNode[] =>
  destinationChoices(nodes, sourceId, keep).filter((node) => keep.includes(node.id) || !heldByLots(node))

export interface KindGroup {
  /** The kind, or "SETUP" for the opening-balance nodes. */
  kind: LedgerKind | "SETUP"
  label: string
  nodes: PickerNode[]
}

const byName = (a: PickerNode, b: PickerNode) => a.name.localeCompare(b.name)

/** The nodes grouped by kind in the order the ledger screen uses, empty kinds left out, each group sorted by name. */
export function groupByKind(nodes: readonly PickerNode[]): KindGroup[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_COPY[kind].plural,
    nodes: nodes.filter((node) => node.kind === kind).sort(byName),
  })).filter((group) => group.nodes.length > 0)
}

/** The same with the opening-balance nodes first, in a group of their own, "Setup", apart from the ordinary kinds. */
export function groupWithSetup(nodes: readonly PickerNode[]): KindGroup[] {
  const setup = nodes.filter(isOpening).sort(byName)
  const rest = groupByKind(nodes.filter((node) => !isOpening(node)))
  return setup.length > 0 ? [{ kind: "SETUP", label: "Setup", nodes: setup }, ...rest] : rest
}

/** The node's name as a picker or a row prints it: an archived node says so, since it can no longer be chosen anew. */
export const nodeLabel = (node: PickerNode): string => (node.archived ? `${node.name} (archived)` : node.name)
