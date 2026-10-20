import type { LedgerNode } from "@prisma/client"
import { serialisePaise } from "./serialise"

// A node as it crosses to the browser. Not the Prisma row: `creditLimitPaise` is a bigint, which JSON.stringify
// throws on (the failure would surface at runtime, in the response of a Server Action), and the dates must be
// strings to survive the trip. `userId` is left off because the client has no use for it.
export interface NodeView {
  id: string
  kind: LedgerNode["kind"]
  name: string
  parentId: string | null
  institution: string | null
  lastFour: string | null
  assetSubtype: LedgerNode["assetSubtype"]
  liabilitySubtype: LedgerNode["liabilitySubtype"]
  /** Paise, as a decimal string. */
  creditLimitPaise: string | null
  statementDay: number | null
  dueDay: number | null
  valuationMode: LedgerNode["valuationMode"]
  unitLabel: string | null
  lotMethod: LedgerNode["lotMethod"]
  stalePriceDays: number | null
  blockNegative: boolean
  systemRole: LedgerNode["systemRole"]
  /** ISO-8601, or null while the node is live. */
  archivedAt: string | null
  createdAt: string
}

export function toNodeView(node: LedgerNode): NodeView {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    parentId: node.parentId,
    institution: node.institution,
    lastFour: node.lastFour,
    assetSubtype: node.assetSubtype,
    liabilitySubtype: node.liabilitySubtype,
    creditLimitPaise: node.creditLimitPaise === null ? null : serialisePaise(node.creditLimitPaise),
    statementDay: node.statementDay,
    dueDay: node.dueDay,
    valuationMode: node.valuationMode,
    unitLabel: node.unitLabel,
    lotMethod: node.lotMethod,
    stalePriceDays: node.stalePriceDays,
    blockNegative: node.blockNegative,
    systemRole: node.systemRole,
    archivedAt: node.archivedAt === null ? null : node.archivedAt.toISOString(),
    createdAt: node.createdAt.toISOString(),
  }
}
