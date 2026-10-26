import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { calendarDate, todayIn, toDbDate } from "@/domain/calendar-date"
import { appendEntries } from "@/app/transactions/entries"
import type { ListEntry } from "@/lib/transaction-list-view"
import { prisma } from "@/server/db"
import { sellInvestment } from "@/server/services/investment-service"
import { loadTransactionPage, loadTransactionScreen } from "@/server/services/transaction-list"
import { recordTransaction } from "@/server/services/transaction-service"
import { createRegistry } from "./repositories/fixtures"

// What the transaction screen reads, from real rows: a split is one entry carrying all of its legs even where a page
// ends in the middle of it, the default is the current month, and everything survives the trip to the browser.

const registry = createRegistry()
afterAll(registry.cleanup)

const day = (value: string) => toDbDate(calendarDate(value))

async function world() {
  const user = await registry.makeUser()
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  const clothes = await registry.makeNode(user.id, "EXPENSE", "Clothes")
  const salary = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  return { user, bank, food, clothes, salary }
}

async function makeGroup(userId: string, from: string, legs: { to: string; amount: bigint }[], occurredAt: string) {
  const group = await prisma.transactionGroup.create({ data: { userId, kind: "MANUAL_SPLIT" } })
  const rows = []
  for (const leg of legs) {
    rows.push(
      await prisma.transaction.create({
        data: { userId, fromNodeId: from, toNodeId: leg.to, amountPaise: leg.amount, occurredAt: day(occurredAt), groupId: group.id, note: "trip" },
      }),
    )
  }
  return { group, rows }
}

const describeEntry = (entry: ListEntry) => (entry.kind === "group" ? `group:${entry.legs.length}` : "single")

describe("loadTransactionPage", () => {
  it("shows a split as one entry with every leg and the sum of them", async () => {
    const { user, bank, food, clothes } = await world()
    await registry.makeTransaction(user.id, bank.id, food.id, { occurredAt: "2026-04-02", amountPaise: 500n })
    const { group } = await makeGroup(user.id, bank.id, [{ to: food.id, amount: 3_334n }, { to: clothes.id, amount: 3_333n }, { to: food.id, amount: 3_333n }], "2026-04-01")
    const page = await loadTransactionPage(user.id, {})
    expect(page.entries.map(describeEntry)).toEqual(["single", "group:3"])
    expect(page.entries[1]).toMatchObject({ kind: "group", groupId: group.id, totalPaise: "10000", fromNodeId: bank.id, occurredAt: "2026-04-01" })
    expect(page.nextCursor).toBeNull()
  })

  it("shows the whole group when only one of its legs matches the filter, and the total is still the sum of the legs shown", async () => {
    const { user, bank, food, clothes } = await world()
    await makeGroup(user.id, bank.id, [{ to: food.id, amount: 6_000n }, { to: clothes.id, amount: 4_000n }], "2026-04-01")
    const page = await loadTransactionPage(user.id, { node: clothes.id })
    expect(page.entries).toHaveLength(1)
    const [entry] = page.entries
    expect(entry.kind === "group" && entry.legs.map((leg) => leg.amountPaise)).toEqual(["6000", "4000"])
    expect(entry.kind === "group" && entry.totalPaise).toBe("10000")
  })

  it("keeps a split whole when a page ends in the middle of it, and the next page does not leave it half-shown", async () => {
    const { user, bank, food, clothes } = await world()
    // 49 newer rows, then a 3-leg split a day earlier: the 50-row page takes the first leg and the cut falls inside the group.
    await prisma.transaction.createMany({
      data: Array.from({ length: 49 }, (_, index) => ({
        userId: user.id,
        fromNodeId: bank.id,
        toNodeId: food.id,
        amountPaise: BigInt(index + 1),
        occurredAt: day("2026-04-02"),
      })),
    })
    const { group } = await makeGroup(user.id, bank.id, [{ to: food.id, amount: 100n }, { to: clothes.id, amount: 200n }, { to: food.id, amount: 300n }], "2026-04-01")

    const first = await loadTransactionPage(user.id, {})
    expect(first.entries).toHaveLength(50)
    expect(first.nextCursor).not.toBeNull()
    const last = first.entries[49]
    expect(last).toMatchObject({ kind: "group", groupId: group.id, totalPaise: "600" })
    expect(last.kind === "group" && last.legs).toHaveLength(3) // not just the leg that fit

    // The other two legs arrive with the next page, as the same group, whole again: the server keeps no memory.
    const second = await loadTransactionPage(user.id, {}, first.nextCursor ?? undefined)
    expect(second.entries.map(describeEntry)).toEqual(["group:3"])
    expect(second.nextCursor).toBeNull()
    // So the list component's merge is what makes it appear once, with nothing lost and nothing doubled.
    const merged = appendEntries(first.entries, second.entries)
    expect(merged).toHaveLength(50)
    expect(merged.filter((entry) => entry.kind === "group")).toHaveLength(1)
    const rowIds = merged.flatMap((entry) => (entry.kind === "group" ? entry.legs.map((leg) => leg.id) : [entry.transaction.id]))
    expect(new Set(rowIds).size).toBe(rowIds.length)
    expect(rowIds).toHaveLength(52) // 49 + 3
  })

  it("shows a group with one live member as an ordinary row, and leaves out members that are deleted", async () => {
    const { user, bank, food, clothes } = await world()
    const { rows } = await makeGroup(user.id, bank.id, [{ to: food.id, amount: 100n }, { to: clothes.id, amount: 200n }], "2026-04-01")
    await prisma.transaction.update({ where: { id: rows[1].id }, data: { deletedAt: new Date() } })
    const page = await loadTransactionPage(user.id, {})
    expect(page.entries.map(describeEntry)).toEqual(["single"])
    expect(page.entries[0]).toMatchObject({ kind: "single", transaction: { id: rows[0].id, groupId: rows[0].groupId } })
  })

  it("lists deleted rows only when asked, marked as deleted, and still shows the live ones beside them", async () => {
    const { user, bank, food, salary } = await world()
    const kept = await registry.makeTransaction(user.id, salary.id, bank.id, { occurredAt: "2026-04-01", note: "kept" })
    const gone = await registry.makeTransaction(user.id, bank.id, food.id, { occurredAt: "2026-04-02", note: "gone" })
    await prisma.transaction.update({ where: { id: gone.id }, data: { deletedAt: new Date() } })

    expect((await loadTransactionPage(user.id, {})).entries.map((e) => e.kind === "single" && e.transaction.id)).toEqual([kept.id])
    const page = await loadTransactionPage(user.id, { deleted: true })
    expect(page.entries).toHaveLength(2)
    expect(page.entries.map((e) => e.kind === "single" && [e.transaction.id, e.transaction.deleted])).toEqual([[gone.id, true], [kept.id, false]])
  })

  it("shows a deleted split as one deleted entry with every leg and its total, and a live split as live", async () => {
    const { user, bank, food, clothes } = await world()
    const dead = await makeGroup(user.id, bank.id, [{ to: food.id, amount: 6_000n }, { to: clothes.id, amount: 4_000n }], "2026-04-02")
    await prisma.transaction.updateMany({ where: { groupId: dead.group.id }, data: { deletedAt: new Date() } })
    const live = await makeGroup(user.id, bank.id, [{ to: food.id, amount: 100n }, { to: clothes.id, amount: 200n }], "2026-04-01")

    expect((await loadTransactionPage(user.id, {})).entries.map((e) => e.kind === "group" && e.groupId)).toEqual([live.group.id])
    const page = await loadTransactionPage(user.id, { deleted: true })
    expect(page.entries.map(describeEntry)).toEqual(["group:2", "group:2"])
    expect(page.entries[0]).toMatchObject({ kind: "group", groupId: dead.group.id, deleted: true, totalPaise: "10000" })
    expect(page.entries[1]).toMatchObject({ kind: "group", groupId: live.group.id, deleted: false, totalPaise: "300" })
  })

  it("never counts a deleted row in a balance, whether or not the list shows it", async () => {
    const { user, bank, salary } = await world()
    const row = await registry.makeTransaction(user.id, salary.id, bank.id, { occurredAt: "2020-01-01", amountPaise: 5_000n })
    await prisma.transaction.update({ where: { id: row.id }, data: { deletedAt: new Date() } })
    const hidden = await loadTransactionScreen(user.id, { from: "", to: "" })
    const shown = await loadTransactionScreen(user.id, { from: "", to: "", deleted: "1" })
    expect(hidden.page.entries).toHaveLength(0)
    expect(shown.page.entries).toHaveLength(1)
    expect(hidden.balances[bank.id]).toBe("0")
    expect(shown.balances[bank.id]).toBe("0")
    expect(shown.filter.deleted).toBe("1")
    expect(hidden.filter.deleted).toBe("")
  })

  it("filters by the kind at either end, and finds nothing through another user's node", async () => {
    const { user, bank, food, salary } = await world()
    const other = await world()
    await registry.makeTransaction(user.id, salary.id, bank.id, { occurredAt: "2026-04-01" })
    await registry.makeTransaction(user.id, bank.id, food.id, { occurredAt: "2026-04-02" })
    expect((await loadTransactionPage(user.id, { kind: "INCOME_SOURCE" })).entries).toHaveLength(1)
    expect((await loadTransactionPage(user.id, { kind: "ASSET" })).entries).toHaveLength(2)
    expect((await loadTransactionPage(user.id, { node: other.bank.id })).entries).toHaveLength(0)
  })

  it("gives each purchase the quantity its lot holds, null for one without a lot, and nothing on a split's legs", async () => {
    const { user, bank, food, clothes } = await world()
    const gold = await registry.makeNode(user.id, "INVESTMENT", "Gold", { valuationMode: "QUANTITY", unitLabel: "g" })
    const bought = await registry.makeTransaction(user.id, bank.id, gold.id, { amountPaise: 70_000_00n, occurredAt: "2026-04-03", note: "bought" })
    await prisma.investmentLot.create({
      data: { userId: user.id, nodeId: gold.id, transactionId: bought.id, quantity: "10.5", costBasisPaise: 70_000_00n, acquiredAt: day("2026-04-03") },
    })
    await registry.makeTransaction(user.id, bank.id, gold.id, { amountPaise: 1_000_00n, occurredAt: "2026-04-02", note: "legacy" })
    await makeGroup(user.id, bank.id, [{ to: food.id, amount: 100n }, { to: clothes.id, amount: 200n }], "2026-04-01")
    const page = await loadTransactionPage(user.id, {})
    const singles = page.entries.flatMap((entry) => (entry.kind === "single" ? [entry.transaction] : []))
    expect(singles.map((view) => [view.note, view.quantity])).toEqual([["bought", "10.5"], ["legacy", null]])
    const group = page.entries.find((entry) => entry.kind === "group")
    expect(group?.kind === "group" && group.legs.every((leg) => !("quantity" in leg))).toBe(true)
  })

  it("marks a sale, which cannot be edited: a break-even sale's one leg, every leg of a sale at a gain, a deleted sale; never an ordinary split", async () => {
    const { user, bank, food, clothes } = await world()
    await registry.makeNode(user.id, "INCOME_SOURCE", "Realised Gain", { systemRole: "REALISED_GAIN" })
    await registry.makeNode(user.id, "EXPENSE", "Realised Loss", { systemRole: "REALISED_LOSS" })
    const gold = await registry.makeNode(user.id, "INVESTMENT", "Gold", { valuationMode: "QUANTITY", unitLabel: "g" })
    const bought = await recordTransaction(user.id, {
      fromNodeId: bank.id,
      toNodeId: gold.id,
      amount: 70_000_00n,
      quantity: 10_000_000n,
      occurredAt: calendarDate("2026-04-01"),
      idempotencyKey: randomUUID(),
    })
    const sell = (quantity: bigint, proceeds: bigint, occurredAt: string) =>
      sellInvestment(user.id, { nodeId: gold.id, toNodeId: bank.id, quantity, proceeds, occurredAt: calendarDate(occurredAt), idempotencyKey: randomUUID() })
    const evenSale = await sell(2_000_000n, 14_000_00n, "2026-04-05") // 2 g at cost: one plain leg
    const gainSale = await sell(3_000_000n, 30_000_00n, "2026-04-06") // 3 g for more than cost: a DISPOSAL group of two legs
    const goneSale = await sell(1_000_000n, 7_000_00n, "2026-04-07")
    await prisma.transaction.update({ where: { id: goneSale.legs[0].id }, data: { deletedAt: new Date() } })
    const split = await makeGroup(user.id, bank.id, [{ to: food.id, amount: 100n }, { to: clothes.id, amount: 200n }], "2026-04-04")
    expect(evenSale.legs).toHaveLength(1)
    expect(gainSale.legs).toHaveLength(2)

    const page = await loadTransactionPage(user.id, { deleted: true })
    const flagOf = (entry: ListEntry) => ("sale" in entry ? entry.sale : undefined)
    const byId = (id: string) => page.entries.find((entry) => (entry.kind === "single" ? entry.transaction.id === id : entry.legs.some((leg) => leg.id === id)))
    expect(flagOf(byId(evenSale.legs[0].id)!)).toBe(true)
    expect(byId(gainSale.legs[0].id)).toMatchObject({ kind: "group", sale: true })
    expect(flagOf(byId(goneSale.legs[0].id)!)).toBe(true)
    expect(flagOf(byId(split.rows[0].id)!)).toBeUndefined()
    expect(flagOf(byId(bought.id)!)).toBeUndefined()
    expect(() => JSON.stringify(page)).not.toThrow()
  })

  it("is plain data", async () => {
    const { user, bank, food, clothes } = await world()
    await makeGroup(user.id, bank.id, [{ to: food.id, amount: 100n }, { to: clothes.id, amount: 200n }], "2026-04-01")
    await registry.makeTransaction(user.id, bank.id, food.id, { amountPaise: 9_007_199_254_740_993n })
    const page = await loadTransactionPage(user.id, {})
    expect(() => JSON.stringify(page)).not.toThrow()
    expect(JSON.stringify(page)).toContain("9007199254740993")
  })
})

describe("loadTransactionScreen", () => {
  const todayInKolkata = () => todayIn("Asia/Kolkata")

  async function seeded() {
    const ctx = await world()
    const today = todayInKolkata()
    const month = today.slice(0, 7)
    await registry.makeTransaction(ctx.user.id, ctx.salary.id, ctx.bank.id, { occurredAt: `${month}-01`, amountPaise: 100_000n, note: "this month" })
    await registry.makeTransaction(ctx.user.id, ctx.bank.id, ctx.food.id, { occurredAt: "2020-01-15", amountPaise: 2_500n, note: "long ago" })
    await registry.makeTransaction(ctx.user.id, ctx.bank.id, ctx.food.id, { occurredAt: "2099-01-01", amountPaise: 40_000n, note: "far future" })
    return { ...ctx, today }
  }

  it("defaults to the current month, and says so in the filter it returns", async () => {
    const { user, today } = await seeded()
    const screen = await loadTransactionScreen(user.id, {})
    expect(screen.today).toBe(today)
    expect(screen.filter).toMatchObject({ from: `${today.slice(0, 7)}-01`, node: "", kind: "", q: "" })
    expect(screen.filter.to >= today).toBe(true)
    expect(screen.page.entries.map((e) => (e.kind === "single" ? e.transaction.note : null))).toEqual(["this month"])
    expect(screen.problems).toEqual({})
  })

  it("lists everything when the dates are given and blank, and honours explicit ones", async () => {
    const { user } = await seeded()
    const notes = async (query: Record<string, string>) =>
      (await loadTransactionScreen(user.id, query)).page.entries.map((e) => (e.kind === "single" ? e.transaction.note : null))
    expect(await notes({ from: "", to: "" })).toEqual(["far future", "this month", "long ago"])
    expect(await notes({ from: "2020-01-01", to: "2020-12-31" })).toEqual(["long ago"])
    expect(await notes({ from: "", to: "2020-12-31" })).toEqual(["long ago"])
  })

  it("counts balances as of today: the far-future row is on the list but not in any balance", async () => {
    const { user, bank, food } = await seeded()
    const screen = await loadTransactionScreen(user.id, { from: "", to: "" })
    expect(screen.balances[bank.id]).toBe(String(100_000n - 2_500n)) // not minus the 40,000 dated 2099
    expect(screen.balances[food.id]).toBe("2500")
  })

  it("shows an investment held by lots at its value, as the ledger does, or as not valued with why; one valued by what was put in at its balance", async () => {
    const { user, bank, today } = await seeded()
    const investment = (name: string, valuationMode: "QUANTITY" | "CONTRIBUTION_ONLY") =>
      registry.makeNode(user.id, "INVESTMENT", name, { valuationMode, unitLabel: "g" })
    const gold = await investment("Gold", "QUANTITY")
    const silver = await investment("Silver", "QUANTITY")
    const old = await investment("Old fund", "QUANTITY")
    const ppf = await investment("PPF", "CONTRIBUTION_ONLY")
    const purchase = (to: string, amount: bigint, quantity?: bigint) =>
      recordTransaction(user.id, { fromNodeId: bank.id, toNodeId: to, amount, quantity, occurredAt: calendarDate("2026-01-10"), idempotencyKey: randomUUID() })
    await purchase(gold.id, 70_000_00n, 10_000_000n)
    await purchase(silver.id, 24_000_00n, 250_000_000n)
    await purchase(ppf.id, 1_50_000_00n)
    await registry.makeTransaction(user.id, bank.id, old.id, { amountPaise: 20_000_00n, occurredAt: "2026-01-05" }) // no lot: from before lots
    await prisma.priceSnapshot.create({ data: { userId: user.id, nodeId: gold.id, asOf: toDbDate(calendarDate("2026-03-01")), pricePerUnitPaise: 7_800_00n } })

    const screen = await loadTransactionScreen(user.id, { from: "", to: "" })
    expect(screen.balances[gold.id]).toBe("7800000") // 10 g at ₹7,800, not the ₹70,000 it cost
    expect(screen.priced[gold.id]).toEqual({ asOf: "2026-03-01", stale: today > "2026-03-31" })
    expect(screen.unvalued[gold.id]).toBeUndefined()
    expect(screen.unvalued[silver.id]).toBe("NO_PRICE")
    expect(screen.unvalued[old.id]).toBe("NEEDS_QUANTITY")
    expect(screen.priced[silver.id]).toBeUndefined()
    expect(screen.balances[ppf.id]).toBe("15000000")
    expect(screen.unvalued[ppf.id]).toBeUndefined()
    expect(() => JSON.stringify(screen)).not.toThrow()
  })

  it("answers a bad filter with the reasons beside their fields and an empty list, not a list the filter did not make", async () => {
    const { user } = await seeded()
    const screen = await loadTransactionScreen(user.id, { from: "2026-02-30", min: "lots", kind: "BANK" })
    expect(Object.keys(screen.problems).sort()).toEqual(["from", "kind", "min"])
    expect(screen.page).toEqual({ entries: [], nextCursor: null })
    expect(screen.filter).toMatchObject({ from: "2026-02-30", min: "lots" }) // what was typed stays on screen
  })

  it("lists every node including archived ones, flagged, and survives JSON", async () => {
    const { user, bank } = await seeded()
    await prisma.ledgerNode.update({ where: { id: bank.id }, data: { archivedAt: new Date() } })
    const screen = await loadTransactionScreen(user.id, { from: "", to: "" })
    expect(() => JSON.stringify(screen)).not.toThrow()
    expect(screen.nodes.find((node) => node.id === bank.id)).toMatchObject({ name: "Bank", kind: "ASSET", archived: true, systemRole: null })
    expect(screen.nodes).toHaveLength(4)
  })

  it("reads one value per filter and ignores nothing it was given for another user", async () => {
    const { user } = await seeded()
    const other = await world()
    await registry.makeTransaction(other.user.id, other.bank.id, other.food.id, { note: "not mine" })
    const screen = await loadTransactionScreen(user.id, { from: "", to: "", q: "not mine" })
    expect(screen.page.entries).toEqual([])
    expect(screen.nodes.some((node) => node.id === other.bank.id)).toBe(false)
  })
})
