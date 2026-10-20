import { describe, expect, it } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import type { ListEntry } from "@/lib/transaction-list-view"
import type { TransactionView } from "@/lib/transaction-view"
import { appendEntries } from "./entries"

const view = (id: string, groupId: string | null = null): TransactionView => ({
  id,
  fromNodeId: "bank",
  toNodeId: "food",
  amountPaise: "100",
  occurredAt: calendarDate("2026-04-01"),
  note: null,
  tags: [],
  groupId,
  deleted: false,
  version: 0,
  warnings: [],
})
const single = (id: string): ListEntry => ({ kind: "single", transaction: view(id) })
const group = (groupId: string, ...legIds: string[]): ListEntry => ({
  kind: "group",
  groupId,
  occurredAt: calendarDate("2026-04-01"),
  fromNodeId: "bank",
  totalPaise: String(legIds.length * 100),
  deleted: false,
  legs: legIds.map((id) => view(id, groupId)),
})
const names = (entries: ListEntry[]) => entries.map((e) => (e.kind === "group" ? e.groupId : e.transaction.id))

describe("appendEntries", () => {
  it("adds a later page after the earlier ones", () => {
    expect(names(appendEntries([single("a"), single("b")], [single("c"), group("g", "x", "y")]))).toEqual(["a", "b", "c", "g"])
  })

  it("drops a group the earlier page already showed whole, when the cut fell between its legs", () => {
    // Leg x was last on page 1, leg y first on page 2: both pages arrive as the whole group.
    const merged = appendEntries([single("a"), group("g", "x", "y")], [group("g", "x", "y"), single("c")])
    expect(names(merged)).toEqual(["a", "g", "c"])
  })

  it("drops a row it already has, and a stray leg of a group it already has", () => {
    expect(names(appendEntries([single("a"), group("g", "x", "y")], [single("a"), { kind: "single", transaction: view("y", "g") }, single("d")]))).toEqual([
      "a",
      "g",
      "d",
    ])
  })

  it("does not repeat an entry within the page it adds", () => {
    expect(names(appendEntries([], [single("a"), single("a")]))).toEqual(["a"])
  })
})
