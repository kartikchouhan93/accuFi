import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { sumNetIntoNodes } from "@/server/repositories/transaction-repository"
import { loadBudgetAttention, loadBudgetsScreen } from "@/server/services/budget-report"
import { loadRanked } from "@/server/services/report-service"
import { createRegistry } from "../repositories/fixtures"

// The live evaluation against the real database. "Today" is moved with a fake Date (nothing else), which `todayFor` and
// `todayIn` read. The 19th of May 2026 at 06:00Z is the same day in Kolkata and New York, so the current month is
// 2026-05 in both runs of scripts/test-tz.sh; the two-timezone tests set the users' own zones.

const registry = createRegistry()
afterAll(registry.cleanup)
afterEach(() => {
  vi.useRealTimers()
})

const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) })
const m = (value: string) => calendarDate(value)
const TODAY = "2026-05-19T06:00:00Z"

/** A user with a bank and a Food expense ledger; `spend` and `refund` record entries on any expense ledger. */
async function setup(timezone?: string) {
  const user = await registry.makeUser()
  if (timezone) await prisma.user.update({ where: { id: user.id }, data: { timezone } })
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  const spend = (nodeId: string, occurredAt: string, amountPaise: bigint) =>
    registry.makeTransaction(user.id, bank.id, nodeId, { amountPaise, occurredAt })
  const refund = (nodeId: string, occurredAt: string, amountPaise: bigint) =>
    registry.makeTransaction(user.id, nodeId, bank.id, { amountPaise, occurredAt })
  const child = (name: string, over: { archivedAt?: Date } = {}) =>
    registry.makeNode(user.id, "EXPENSE", name, { parentId: food.id, ...over })
  return { user, bank, food, spend, refund, child }
}

const queryOf = (href: string) => new URL(href, "http://x").searchParams

describe("reconciliation with the Transactions screen and the Spending report", () => {
  it("a parent is its own spend plus its children's, and the figure is the one the other screens show", async () => {
    at(TODAY)
    const w = await setup()
    const veg = await w.child("Vegetables")
    const dairy = await w.child("Dairy")
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-04-01", amountPaise: 50_000n })
    await registry.makeBudget(w.user.id, dairy.id, { startMonth: "2026-04-01", amountPaise: 10_000n })
    await w.spend(w.food.id, "2026-05-03", 10_000n)
    await w.spend(veg.id, "2026-05-10", 4_000n)
    await w.spend(dairy.id, "2026-05-11", 2_500n)
    await w.spend(w.food.id, "2026-04-20", 7_777n) // another month: not in May

    const screen = await loadBudgetsScreen(w.user.id)
    const food = screen.cards.find((c) => c.nodeId === w.food.id)!
    const dairyCard = screen.cards.find((c) => c.nodeId === dairy.id)!

    // The child's spend is in both cards, once in each.
    expect(food.usedPaise).toBe("16500")
    expect(food.countedNames).toEqual(["Vegetables", "Dairy"])
    expect(dairyCard.usedPaise).toBe("2500")
    expect(dairyCard.countedNames).toEqual([])

    // The drill link is exactly what the Transactions screen totals.
    const query = queryOf(food.drillHref)
    expect(food.drillHref.startsWith("/transactions?")).toBe(true)
    expect(query.get("flow")).toBe("spending")
    expect(query.get("from")).toBe("2026-05-01")
    expect(query.get("to")).toBe("2026-05-19")
    const nodeIds = query.get("node")!.split(",")
    expect(nodeIds).toEqual([w.food.id, veg.id, dairy.id])
    const net = await sumNetIntoNodes(w.user.id, { nodeIds, from: m("2026-05-01"), to: m("2026-05-19") })
    expect(String(net)).toBe(food.usedPaise)

    // And the Spending report's row for the same month.
    const ranked = await loadRanked(w.user.id, { kind: "month", year: 2026, month: 5 }, "EXPENSE")
    const row = [...ranked.rows, ...ranked.refunds].find((r) => r.id === w.food.id)!
    expect(row.paise).toBe(food.usedPaise)
    const dairyRow = row.children.find((r) => r.id === dairy.id)!
    expect(dairyRow.paise).toBe(dairyCard.usedPaise)
  })

  it("a past month's history row drills to that whole month and agrees with the report", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-03-01" })
    await w.spend(w.food.id, "2026-04-30", 1_234n)
    await w.spend(w.food.id, "2026-05-01", 999n)

    const [card] = (await loadBudgetsScreen(w.user.id)).cards
    const april = card.history.find((r) => r.month === "2026-04-01")!
    expect(april.usedPaise).toBe("1234")
    const query = queryOf(april.drillHref)
    expect([query.get("from"), query.get("to")]).toEqual(["2026-04-01", "2026-04-30"])
    const net = await sumNetIntoNodes(w.user.id, { nodeIds: [w.food.id], from: m("2026-04-01"), to: m("2026-04-30") })
    expect(String(net)).toBe(april.usedPaise)
    const ranked = await loadRanked(w.user.id, { kind: "month", year: 2026, month: 4 }, "EXPENSE")
    expect(ranked.rows.find((r) => r.id === w.food.id)!.paise).toBe(april.usedPaise)
    // The current month's row drills through today only.
    expect(queryOf(card.history[0].drillHref).get("to")).toBe("2026-05-19")
  })
})

describe("the exit criterion: backdated spend reopens a closed month", () => {
  it("a closed month under budget goes OVER when an expense is dated inside it, and back when it is deleted", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-03-01", amountPaise: 500_000n })
    const april = m("2026-04-01")
    const aprilCard = async () => {
      const screen = await loadBudgetsScreen(w.user.id, april)
      expect(screen.month).toBe("2026-04-01")
      return screen.cards[0]
    }

    await w.spend(w.food.id, "2026-04-05", 100_000n)
    expect((await aprilCard()).status).toBe("ON_TRACK")

    const late = await w.spend(w.food.id, "2026-04-12", 420_000n)
    const over = await aprilCard()
    expect(over.status).toBe("OVER")
    expect(over.usedPaise).toBe("520000")
    expect(over.remainingPaise).toBe("-20000")
    expect(over.projectionPaise).toBeNull() // a closed month is its own total
    const current = (await loadBudgetsScreen(w.user.id)).cards[0]
    expect(current.history.find((r) => r.month === "2026-04-01")).toMatchObject({ status: "OVER", usedPaise: "520000" })

    await prisma.transaction.update({ where: { id: late.id }, data: { deletedAt: new Date() } })
    const back = await aprilCard()
    expect(back.status).toBe("ON_TRACK")
    expect(back.usedPaise).toBe("100000")
  })
})

describe("what counts in a month", () => {
  it("counts the current month through today only: a future-dated entry is left out", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-05-01" })
    await w.spend(w.food.id, "2026-05-19", 3_000n)
    await w.spend(w.food.id, "2026-05-20", 90_000n)
    await w.spend(w.food.id, "2026-06-02", 90_000n)
    const [card] = (await loadBudgetsScreen(w.user.id)).cards
    expect(card.usedPaise).toBe("3000")
    expect(card.history).toHaveLength(1)
  })

  it("a refund lowers used in the month it happened (EC-52), and a net-refund month is negative", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-04-01" })
    await w.spend(w.food.id, "2026-05-10", 30_000n)
    await w.refund(w.food.id, "2026-05-12", 10_000n)
    await w.refund(w.food.id, "2026-04-15", 5_000n) // April: only a refund

    const may = (await loadBudgetsScreen(w.user.id)).cards[0]
    expect(may.usedPaise).toBe("20000")
    const april = (await loadBudgetsScreen(w.user.id, m("2026-04-01"))).cards[0]
    expect(april.usedPaise).toBe("-5000")
    expect(april.percentTenths).toBeNull()
    expect(april.status).toBe("ON_TRACK")
    expect(april.remainingPaise).toBe(String(500_000 + 5_000))
  })

  it("spend dated before the budget was created in the same month counts (EC-48), and spend before its start month does not", async () => {
    at(TODAY)
    const w = await setup()
    await w.spend(w.food.id, "2026-05-02", 12_000n)
    await w.spend(w.food.id, "2026-03-20", 99_000n)
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-05-01" }) // made after the entries
    const screen = await loadBudgetsScreen(w.user.id)
    expect(screen.months).toEqual(["2026-05-01"])
    expect(screen.cards[0].usedPaise).toBe("12000")
    expect(screen.cards[0].history.map((r) => [r.month, r.usedPaise])).toEqual([["2026-05-01", "12000"]])
    // Asking for March is clamped to May: there is no card or history for it.
    expect((await loadBudgetsScreen(w.user.id, m("2026-03-01"))).month).toBe("2026-05-01")
  })
})

describe("the user's own timezone decides the month", () => {
  it("two users on opposite sides of the date line see their own current month", async () => {
    // 12:00Z on 31 Oct is already 1 Nov in Kiritimati (UTC+14) and still 31 Oct in Pago Pago (UTC-11).
    at("2026-10-31T12:00:00Z")
    const east = await setup("Pacific/Kiritimati")
    const west = await setup("Pacific/Pago_Pago")
    for (const w of [east, west]) {
      await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-10-01", amountPaise: 100_000n })
      await w.spend(w.food.id, "2026-10-31", 10_000n)
      await w.spend(w.food.id, "2026-11-01", 20_000n)
    }

    const kiritimati = await loadBudgetsScreen(east.user.id)
    expect(kiritimati.today).toBe("2026-11-01")
    expect(kiritimati.month).toBe("2026-11-01")
    expect(kiritimati.months).toEqual(["2026-10-01", "2026-11-01"])
    expect(kiritimati.cards[0].usedPaise).toBe("20000")
    expect(kiritimati.cards[0].history.map((r) => [r.month, r.usedPaise])).toEqual([
      ["2026-11-01", "20000"],
      ["2026-10-01", "10000"],
    ])

    const pago = await loadBudgetsScreen(west.user.id)
    expect(pago.today).toBe("2026-10-31")
    expect(pago.month).toBe("2026-10-01")
    expect(pago.months).toEqual(["2026-10-01"])
    expect(pago.cards[0].usedPaise).toBe("10000") // 1 Nov is still in their future
  })

  it("the selectable months are right on 1 January and on 31 December", async () => {
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2025-11-01" })
    at("2026-01-01T06:00:00Z") // 11:30 on 1 Jan in Kolkata
    expect((await loadBudgetsScreen(w.user.id)).months).toEqual(["2025-11-01", "2025-12-01", "2026-01-01"])

    const v = await setup()
    await registry.makeBudget(v.user.id, v.food.id, { startMonth: "2026-11-01" })
    at("2026-12-31T06:00:00Z")
    const screen = await loadBudgetsScreen(v.user.id)
    expect(screen.months).toEqual(["2026-11-01", "2026-12-01"])
    expect(screen.month).toBe("2026-12-01")
  })
})

describe("which ledgers count", () => {
  it("an archived ledger's budget is still a card, and an archived child still counts toward its parent", async () => {
    at(TODAY)
    const w = await setup()
    const old = await w.child("Old snacks", { archivedAt: new Date() })
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-05-01" })
    await w.spend(old.id, "2026-05-04", 2_000n)
    const [card] = (await loadBudgetsScreen(w.user.id)).cards
    expect(card.usedPaise).toBe("2000")
    expect(card.countedNames).toEqual(["Old snacks"])

    await prisma.ledgerNode.update({ where: { id: w.food.id }, data: { archivedAt: new Date() } })
    const archived = (await loadBudgetsScreen(w.user.id)).cards[0]
    expect(archived.archived).toBe(true)
    expect(archived.usedPaise).toBe("2000")
  })

  it("a child added after the budget counts from its own entries on", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-04-01" })
    await w.spend(w.food.id, "2026-04-10", 1_000n)
    const late = await w.child("Added later")
    await w.spend(late.id, "2026-05-05", 4_000n)
    const screen = await loadBudgetsScreen(w.user.id)
    expect(screen.cards[0].usedPaise).toBe("4000")
    expect(screen.cards[0].history.map((r) => r.usedPaise)).toEqual(["4000", "1000"])
  })

  it("system ledgers are never counted", async () => {
    at(TODAY)
    const w = await setup()
    const contra = await registry.makeNode(w.user.id, "EXPENSE", "Opening Balance Contra", {
      parentId: w.food.id,
      systemRole: "OPENING_BALANCE_CONTRA",
    })
    const loss = await registry.makeNode(w.user.id, "EXPENSE", "Realised Loss", { parentId: w.food.id, systemRole: "REALISED_LOSS" })
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-05-01" })
    await w.spend(w.food.id, "2026-05-02", 1_000n)
    await w.spend(contra.id, "2026-05-02", 50_000n)
    await w.spend(loss.id, "2026-05-02", 70_000n)
    const [card] = (await loadBudgetsScreen(w.user.id)).cards
    expect(card.usedPaise).toBe("1000")
    expect(card.countedNames).toEqual([])
    expect(queryOf(card.drillHref).get("node")).toBe(w.food.id)
  })
})

describe("rollover, projection and ordering", () => {
  it("a rollover chain across two spans shows in carry and available", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-04-01", endMonth: "2026-04-01", amountPaise: 100_000n, rollover: true })
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-05-01", amountPaise: 200_000n, rollover: true })
    await w.spend(w.food.id, "2026-04-09", 30_000n)
    await w.spend(w.food.id, "2026-05-09", 50_000n)

    const [card] = (await loadBudgetsScreen(w.user.id)).cards
    expect(card).toMatchObject({
      amountPaise: "200000",
      carryPaise: "70000",
      availablePaise: "270000",
      usedPaise: "50000",
      remainingPaise: "220000",
      rollover: true,
      startMonth: "2026-05-01",
      endMonth: null,
    })
    expect(card.history.map((r) => r.availablePaise)).toEqual(["270000", "100000"])
    const april = (await loadBudgetsScreen(w.user.id, m("2026-04-01"))).cards[0]
    expect(april).toMatchObject({ startMonth: "2026-04-01", endMonth: "2026-04-01", carryPaise: "0" })
  })

  it("a projection appears for the current month once 7 days have elapsed, and not before or for another month", async () => {
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-04-01", amountPaise: 250_000n })
    await w.spend(w.food.id, "2026-05-02", 190_000n)
    await w.spend(w.food.id, "2026-04-02", 1_000n)

    at(TODAY) // 19 days in: 190,000 x 31 / 19 = 310,000
    const may = (await loadBudgetsScreen(w.user.id)).cards[0]
    expect(may.projectionPaise).toBe("310000")
    expect(may.overAtPace).toBe(true)
    expect((await loadBudgetsScreen(w.user.id, m("2026-04-01"))).cards[0].projectionPaise).toBeNull()

    at("2026-05-06T06:00:00Z") // 6 days in
    expect((await loadBudgetsScreen(w.user.id)).cards[0].projectionPaise).toBeNull()
    at("2026-05-07T06:00:00Z") // 7 days in
    expect((await loadBudgetsScreen(w.user.id)).cards[0].projectionPaise).not.toBeNull()
  })

  it("orders cards most strained first: over, near, then percent, then name", async () => {
    at(TODAY)
    const w = await setup()
    const named = async (name: string, used: bigint, kind: "spend" | "refund" = "spend") => {
      const node = await registry.makeNode(w.user.id, "EXPENSE", name)
      await registry.makeBudget(w.user.id, node.id, { startMonth: "2026-05-01", amountPaise: 50_000n })
      if (used > 0n) await (kind === "spend" ? w.spend : w.refund)(node.id, "2026-05-03", used)
    }
    await named("Echo", 0n)
    await named("Aaa", 5_000n, "refund")
    await named("Wax", 10_000n)
    await named("Xu", 40_000n)
    await named("Delta", 0n)
    await named("Yak", 45_000n)
    await named("Zed", 60_000n)
    const screen = await loadBudgetsScreen(w.user.id)
    expect(screen.cards.map((c) => c.name)).toEqual(["Zed", "Yak", "Xu", "Wax", "Delta", "Echo", "Aaa"])
    expect(screen.cards.map((c) => c.status)).toEqual(["OVER", "NEAR", "NEAR", "ON_TRACK", "ON_TRACK", "ON_TRACK", "ON_TRACK"])
  })
})

describe("the screen as a whole", () => {
  it("clamps a month outside the selectable range", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-03-01" })
    const early = await loadBudgetsScreen(w.user.id, m("2020-01-01"))
    expect(early.month).toBe("2026-03-01")
    expect(early.cards).toHaveLength(1)
    const late = await loadBudgetsScreen(w.user.id, m("2031-12-01"))
    expect(late.month).toBe("2026-05-01")
    // Any day of a month names it.
    expect((await loadBudgetsScreen(w.user.id, m("2026-04-17"))).month).toBe("2026-04-01")
  })

  it("is empty with no budgets, and never shows another user's", async () => {
    at(TODAY)
    const w = await setup()
    const other = await setup()
    await registry.makeBudget(other.user.id, other.food.id, { startMonth: "2026-04-01" })
    await other.spend(other.food.id, "2026-05-02", 1_000n)

    const screen = await loadBudgetsScreen(w.user.id)
    expect(screen).toEqual({ today: "2026-05-19", month: "2026-05-01", months: [], cards: [], empty: true, upcomingStart: null })
    expect(await loadBudgetAttention(w.user.id)).toEqual({ near: 0, over: 0 })
  })

  it("a budget with no entries still has a card, and a budget starting next month has none yet", async () => {
    at(TODAY)
    const w = await setup()
    const rent = await registry.makeNode(w.user.id, "EXPENSE", "Rent")
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-05-01" })
    await registry.makeBudget(w.user.id, rent.id, { startMonth: "2026-06-01" })
    const screen = await loadBudgetsScreen(w.user.id)
    expect(screen.empty).toBe(false)
    expect(screen.cards.map((c) => [c.name, c.usedPaise, c.status])).toEqual([["Food", "0", "ON_TRACK"]])
    expect(screen.upcomingStart).toBeNull() // one has started: there are months to show
  })

  it("names the earliest start when every budget starts after the current month: not empty, no months, no cards", async () => {
    at(TODAY)
    const w = await setup()
    const rent = await registry.makeNode(w.user.id, "EXPENSE", "Rent")
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-08-01" })
    await registry.makeBudget(w.user.id, rent.id, { startMonth: "2026-06-01" })
    const screen = await loadBudgetsScreen(w.user.id)
    expect(screen).toEqual({ today: "2026-05-19", month: "2026-05-01", months: [], cards: [], empty: false, upcomingStart: "2026-06-01" })
  })

  it("has no bigint anywhere: JSON.stringify works", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-04-01", rollover: true })
    await w.spend(w.food.id, "2026-05-02", 123_456n)
    const screen = await loadBudgetsScreen(w.user.id)
    expect(() => JSON.stringify(screen)).not.toThrow()
    expect(JSON.parse(JSON.stringify(screen))).toEqual(screen)
  })
})

describe("loadBudgetAttention", () => {
  it("counts near and over for the current month only", async () => {
    at(TODAY)
    const w = await setup()
    const add = async (name: string, thisMonth: bigint, lastMonth: bigint) => {
      const node = await registry.makeNode(w.user.id, "EXPENSE", name)
      await registry.makeBudget(w.user.id, node.id, { startMonth: "2026-04-01", amountPaise: 50_000n })
      if (thisMonth > 0n) await w.spend(node.id, "2026-05-03", thisMonth)
      if (lastMonth > 0n) await w.spend(node.id, "2026-04-03", lastMonth)
    }
    await add("Over now", 60_000n, 0n)
    await add("Near now", 42_000n, 0n)
    await add("Over only in April", 1_000n, 90_000n)
    await add("Fine", 1_000n, 1_000n)
    expect(await loadBudgetAttention(w.user.id)).toEqual({ near: 1, over: 1 })
  })
})
