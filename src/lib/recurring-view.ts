import type { LedgerNode, RecurringOccurrence, RecurringRule } from "@prisma/client"
import { fromDbDate } from "../domain/calendar-date"
import { serialisePaise } from "./serialise"

// An occurrence as it crosses to the browser: the card the inbox shows. Not the Prisma rows: paise are decimal text (a
// bigint breaks JSON.stringify) and days are "YYYY-MM-DD" strings. The money, note and tags are the RULE's current
// template, because that is what posting records unless the user overrides it (spec §8, EC-44): the card shows what a
// click on Post would write. `userId` and the audit timestamps are left off.

export interface OccurrenceView {
  id: string
  ruleId: string
  ruleName: string
  dueOn: string
  status: "PENDING" | "POSTED" | "DISMISSED"
  fromNodeId: string
  toNodeId: string
  fromName: string
  toName: string
  /** Paise, as a decimal string. */
  amountPaise: string
  note: string | null
  tags: string[]
  /** Why an automatic post did not happen, if it did not. */
  postFailure: string | null
  /** The destination is an investment valued by quantity: each post needs a quantity, so Post opens the edit form. */
  needsQuantity: boolean
  /** The destination's unit ("g"), when `needsQuantity`. */
  unitLabel: string | null
  /** Either end is archived: it can be skipped but not posted. */
  nodeArchived: boolean
  transactionId: string | null
}

/** `fromNode` and `toNode` are the rule's two ends, archived or not. Pure: no reads. */
export function toOccurrenceView(
  occurrence: RecurringOccurrence,
  rule: RecurringRule,
  fromNode: LedgerNode,
  toNode: LedgerNode,
): OccurrenceView {
  // The QUANTITY case of the server's `lotModeOf`, spelled out: nothing in src/lib may import server code (a client
  // component imports from here), and the server module reaches the database.
  const needsQuantity = toNode.kind === "INVESTMENT" && toNode.valuationMode === "QUANTITY"
  return {
    id: occurrence.id,
    ruleId: rule.id,
    ruleName: rule.name,
    dueOn: fromDbDate(occurrence.dueOn),
    status: occurrence.status,
    fromNodeId: fromNode.id,
    toNodeId: toNode.id,
    fromName: fromNode.name,
    toName: toNode.name,
    amountPaise: serialisePaise(rule.amountPaise),
    note: rule.note,
    tags: [...rule.tags],
    postFailure: occurrence.postFailure,
    needsQuantity,
    unitLabel: needsQuantity ? toNode.unitLabel : null,
    nodeArchived: fromNode.archivedAt !== null || toNode.archivedAt !== null,
    transactionId: occurrence.transactionId,
  }
}
