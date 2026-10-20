import type { ListEntry } from "@/lib/transaction-list-view"

/**
 * `more`, a later page, added after `current` without anything the list already shows. The server keeps no memory of
 * what it has sent (the cursor is a position, not a session), and a split can straddle the cut between two pages: its
 * legs on the first side bring the whole group in with that page, and its legs on the other side bring it in again with
 * the next. So a group already listed is dropped, and so is a row already listed (a transaction edited or restored while
 * the user paged could otherwise appear twice).
 */
export function appendEntries(current: readonly ListEntry[], more: readonly ListEntry[]): ListEntry[] {
  const groups = new Set<string>()
  const rows = new Set<string>()
  const note = (entry: ListEntry) => {
    if (entry.kind === "group") {
      groups.add(entry.groupId)
      for (const leg of entry.legs) rows.add(leg.id)
    } else {
      rows.add(entry.transaction.id)
    }
  }
  current.forEach(note)
  const fresh: ListEntry[] = []
  for (const entry of more) {
    const known =
      entry.kind === "group"
        ? groups.has(entry.groupId) || entry.legs.some((leg) => rows.has(leg.id))
        : rows.has(entry.transaction.id) || (entry.transaction.groupId !== null && groups.has(entry.transaction.groupId))
    if (known) continue
    note(entry)
    fresh.push(entry)
  }
  return [...current, ...fresh]
}
