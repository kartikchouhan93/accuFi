// What an import row can be matched against before it is committed: a transaction already in the ledger
// (a probable duplicate), a recurring entry still waiting in the inbox, and the counterpart the user chose
// last time for a similar description. All pure functions of plain data, so the service layer only fetches.
//
// Direction is always relative to the batch's account: OUT means the account is the source of the
// transaction (fromNodeId), IN means it is the destination (toNodeId). Day distances go through daysBetween,
// which works on UTC midnights, so the process timezone cannot move a match across the window edge.

import { daysBetween, type CalendarDate } from "./calendar-date"
import type { ImportDirection } from "./import-map"
import { isFlowAllowed, type LedgerKind, type SystemNodeRole } from "./ledger-kind"
import type { Paise } from "./money"

/** A bank date and a ledger date for the same event differ by settlement lag; three days either side covers it. */
export const DUPLICATE_WINDOW_DAYS = 3

interface DatedAmount {
  occurredOn: CalendarDate
  amountPaise: Paise
  direction: ImportDirection
}

const distance = (a: CalendarDate, b: CalendarDate) => Math.abs(daysBetween(a, b))

export interface ExistingTxn {
  id: string
  fromNodeId: string
  toNodeId: string
  amountPaise: Paise
  occurredAt: CalendarDate
}

/**
 * The live transaction an import row probably repeats, or null. Same amount, same direction relative to the
 * account, within the window. Several qualify: the closest date wins, then the lower id, so the answer does
 * not depend on the order the database returned them in.
 */
export function findDuplicate(
  row: DatedAmount,
  accountNodeId: string,
  existing: readonly ExistingTxn[],
): ExistingTxn | null {
  let best: ExistingTxn | null = null
  let bestDistance = Infinity
  for (const txn of existing) {
    const touchesAccount = row.direction === "OUT" ? txn.fromNodeId === accountNodeId : txn.toNodeId === accountNodeId
    if (!touchesAccount || txn.amountPaise !== row.amountPaise) continue
    const days = distance(row.occurredOn, txn.occurredAt)
    if (days > DUPLICATE_WINDOW_DAYS) continue
    if (days < bestDistance || (days === bestDistance && best !== null && txn.id < best.id)) {
      best = txn
      bestDistance = days
    }
  }
  return best
}

/**
 * The existing transactions grouped by amount, so a duplicate lookup only walks the ones that could possibly match
 * (`findDuplicate` requires the exact same amount): pass `index.get(row.amountPaise) ?? []` as its `existing`. The
 * answer is identical to passing the whole list, since every transaction it leaves out has a different amount and
 * would have been skipped anyway; it only stops a dense statement from comparing every row against every transaction.
 */
export function indexByAmount(existing: readonly ExistingTxn[]): Map<Paise, ExistingTxn[]> {
  const index = new Map<Paise, ExistingTxn[]>()
  for (const txn of existing) {
    const bucket = index.get(txn.amountPaise)
    if (bucket) bucket.push(txn)
    else index.set(txn.amountPaise, [txn])
  }
  return index
}

export interface OccurrenceCandidate {
  occurrenceId: string
  ruleName: string
  dueOn: CalendarDate
  amountPaise: Paise
  direction: ImportDirection
  otherNodeId: string
}

/**
 * Pair rows with pending recurring occurrences, one candidate per row at most and one row per candidate.
 * Every eligible (row, candidate) pair is ranked by distance, then row order, then candidate order, and taken
 * greedily: two rows competing for one occurrence give it to the nearer date rather than to whichever came
 * first in the file. The result lines up with `rows` by index.
 */
export function matchOccurrences(
  rows: readonly DatedAmount[],
  candidates: readonly OccurrenceCandidate[],
): (OccurrenceCandidate | null)[] {
  const pairs: { days: number; row: number; candidate: number }[] = []
  rows.forEach((row, r) => {
    candidates.forEach((c, k) => {
      if (c.amountPaise !== row.amountPaise || c.direction !== row.direction) return
      const days = distance(row.occurredOn, c.dueOn)
      if (days <= DUPLICATE_WINDOW_DAYS) pairs.push({ days, row: r, candidate: k })
    })
  })
  pairs.sort((a, b) => a.days - b.days || a.row - b.row || a.candidate - b.candidate)

  const result: (OccurrenceCandidate | null)[] = rows.map(() => null)
  const taken = new Set<number>()
  for (const { row, candidate } of pairs) {
    if (result[row] !== null || taken.has(candidate)) continue
    result[row] = candidates[candidate]
    taken.add(candidate)
  }
  return result
}

export interface LearnedRule {
  direction: ImportDirection
  descriptionKey: string
  nodeId: string
}

const tokens = (key: string) => key.split(" ").filter((t) => t !== "")

/** True when `needle` appears in `haystack` as a run of whole tokens ("AMAZON" is not in "AMAZONIA"). */
function containsTokens(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((t, i) => haystack[start + i] === t)) return true
  }
  return false
}

/**
 * The counterpart a learned rule suggests for a description key: the exact key first, else the longest rule
 * key that sits inside it as whole tokens. Same direction only; an empty key never matches. Equal-length
 * contained keys fall to the lexicographically lower one so the choice is stable.
 */
export function suggestFromRules(
  direction: ImportDirection,
  key: string,
  rules: readonly LearnedRule[],
): string | null {
  const keyTokens = tokens(key)
  if (keyTokens.length === 0) return null
  const sameDirection = rules.filter((r) => r.direction === direction && tokens(r.descriptionKey).length > 0)

  const exact = sameDirection.find((r) => r.descriptionKey === key)
  if (exact) return exact.nodeId

  let best: LearnedRule | null = null
  for (const rule of sameDirection) {
    if (!containsTokens(keyTokens, tokens(rule.descriptionKey))) continue
    if (
      best === null ||
      rule.descriptionKey.length > best.descriptionKey.length ||
      (rule.descriptionKey.length === best.descriptionKey.length && rule.descriptionKey < best.descriptionKey)
    ) {
      best = rule
    }
  }
  return best?.nodeId ?? null
}

/**
 * Whether a ledger may be the other side of an imported row. The flow table (spec 5) decides the kinds; on top
 * of it the counterpart must be a real, live, user-made ledger that is not the account itself and not a lot
 * holder (an investment's movements are lots, which a bank line cannot create).
 */
export function isLegalCounterpart(
  account: { id: string; kind: "ASSET" | "LIABILITY" },
  direction: ImportDirection,
  counterpart: { id: string; kind: LedgerKind; systemRole: SystemNodeRole | null; archived: boolean; heldByLots: boolean },
): boolean {
  if (counterpart.id === account.id || counterpart.archived || counterpart.systemRole !== null || counterpart.heldByLots) {
    return false
  }
  return direction === "OUT" ? isFlowAllowed(account.kind, counterpart.kind) : isFlowAllowed(counterpart.kind, account.kind)
}
