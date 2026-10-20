import { isFlowAllowed, type LedgerKind, type SystemNodeRole } from "@/domain/ledger-kind"
import { KIND_COPY, KIND_ORDER } from "@/lib/node-kinds"
import type { PickerNode } from "@/lib/transaction-list-view"

// Which nodes the form offers. A new entry may use any live node of the user's own; archived nodes (EC-14) are never
// offered. The application's own system nodes are not offered either, with one exception: the two opening-balance nodes
// are offered as SOURCES, so a user who forgot an opening balance can record one later (EC-36), and they go only where
// the node form puts one, an account or a card. Realised gain and loss belong to disposals (M2) and are never offered.
// A transaction being edited is the other exception: the nodes it already names stay on offer however they are classed,
// so a historical row that points at an archived account, or at the contra node, can still be corrected. `keep` is those ids.
//
// The destinations are what the flow rules (spec §5, `isFlowAllowed`) permit from the chosen source, and never the
// source itself. The server checks all of this again; the picker only stops the user being offered what would be refused.

const OPENING_ROLES: ReadonlySet<SystemNodeRole> = new Set(["OPENING_BALANCE", "OPENING_BALANCE_CONTRA"])
// What an opening balance may go to: the node form's own rule (a node that holds a balance a user can state up front).
const OPENING_TARGET_KINDS: ReadonlySet<LedgerKind> = new Set(["ASSET", "LIABILITY"])

const isOpening = (node: PickerNode) => node.systemRole !== null && OPENING_ROLES.has(node.systemRole)
const isOrdinary = (node: PickerNode) => !node.archived && node.systemRole === null

export const sourceChoices = (nodes: readonly PickerNode[], keep: readonly string[] = []): PickerNode[] =>
  nodes.filter((node) => keep.includes(node.id) || isOrdinary(node) || (!node.archived && isOpening(node)))

export function destinationChoices(nodes: readonly PickerNode[], sourceId: string, keep: readonly string[] = []): PickerNode[] {
  const source = nodes.find((node) => node.id === sourceId)
  if (!source) return []
  return nodes.filter(
    (node) =>
      node.id !== source.id &&
      (keep.includes(node.id) || isOrdinary(node)) &&
      isFlowAllowed(source.kind, node.kind) &&
      (!isOpening(source) || OPENING_TARGET_KINDS.has(node.kind)),
  )
}

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

/** The same for the source picker: the opening-balance nodes come first in a group of their own, "Setup", apart from the ordinary kinds. */
export function groupSources(nodes: readonly PickerNode[]): KindGroup[] {
  const setup = nodes.filter(isOpening).sort(byName)
  const rest = groupByKind(nodes.filter((node) => !isOpening(node)))
  return setup.length > 0 ? [{ kind: "SETUP", label: "Setup", nodes: setup }, ...rest] : rest
}

/** The node's name as a picker or a row prints it: an archived node says so, since it can no longer be chosen anew. */
export const nodeLabel = (node: PickerNode): string => (node.archived ? `${node.name} (archived)` : node.name)
