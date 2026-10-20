import { isFlowAllowed, type LedgerKind } from "@/domain/ledger-kind"
import { KIND_COPY, KIND_ORDER } from "@/lib/node-kinds"
import type { PickerNode } from "@/lib/transaction-list-view"

// Which nodes the form offers. A new entry may use any live node of the user's own; archived nodes (EC-14) and the
// application's own system nodes (Opening Balance and the rest, which have their own flows) are never offered. A
// transaction being edited is the exception: the nodes it already names stay on offer however they are classed, so a
// historical row that points at an archived account can still be corrected. `keep` is those ids.
//
// The destinations are what the flow rules (spec §5, `isFlowAllowed`) permit from the chosen source, and never the
// source itself. The server checks all of this again; the picker only stops the user being offered what would be refused.

const offered = (node: PickerNode, keep: readonly string[]) => keep.includes(node.id) || (!node.archived && !node.system)

export const sourceChoices = (nodes: readonly PickerNode[], keep: readonly string[] = []): PickerNode[] =>
  nodes.filter((node) => offered(node, keep))

export function destinationChoices(nodes: readonly PickerNode[], sourceId: string, keep: readonly string[] = []): PickerNode[] {
  const source = nodes.find((node) => node.id === sourceId)
  if (!source) return []
  return nodes.filter((node) => node.id !== source.id && offered(node, keep) && isFlowAllowed(source.kind, node.kind))
}

export interface KindGroup {
  kind: LedgerKind
  label: string
  nodes: PickerNode[]
}

/** The nodes grouped by kind in the order the ledger screen uses, empty kinds left out, each group sorted by name. */
export function groupByKind(nodes: readonly PickerNode[]): KindGroup[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_COPY[kind].plural,
    nodes: nodes.filter((node) => node.kind === kind).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((group) => group.nodes.length > 0)
}

/** The node's name as a picker or a row prints it: an archived node says so, since it can no longer be chosen anew. */
export const nodeLabel = (node: PickerNode): string => (node.archived ? `${node.name} (archived)` : node.name)
