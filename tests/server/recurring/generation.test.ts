import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { addDays, calendarDate, fromDbDate, toDbDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { getDashboard } from "@/server/services/balance-service"
import { generateDue, generateInBackground, sweepAll } from "@/server/services/recurring-generation"
import { loadCashFlow } from "@/server/services/report-service"
import { createRegistry } from "../repositories/fixtures"

// Catch-all generation, the hourly sweep and the sign-in trigger, against the real database. "Today" is moved with a
// fake Date (nothing else), which `todayFor` and `todayIn` read, so each user's own day is exact and repeatable.

// One transaction in the way of a post can be made to fail once, to stand for a transient, unrecognised error.
const flaky = vi.hoisted(() => ({ failNext: false }))
vi.mock("@/server/services/transaction-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/services/transaction-service")>()
  return {
    ...original,
    recordTransaction: (...args: Parameters<typeof original.recordTransaction>) => {
      if (flaky.failNext) {
        flaky.failNext = false
        return Promise.reject(new Error("connection reset by peer"))
      }
      return original.recordTransaction(...args)
    },
  }
})

const registry = createRegistry()
afterAll(registry.cleanup)
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  flaky.failNext = false
})

const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) })
const day = (value: string) => calendarDate(value)

/** A user (Asia/Kolkata unless `timezone` says otherwise) with Rs 1,000.00 in a bank, an expense node and a salary source. */
async function setup(timezone?: string) {
  const user = await registry.makeUser()
  if (timezone) await prisma.user.update({ where: { id: user.id }, data: { timezone } })
  const income = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  await registry.makeTransaction(user.id, income.id, bank.id, { amountPaise: 1_000_00n, occurredAt: "2000-01-01" })
  return { user, income, bank, food }
}
type World = Awaited<ReturnType<typeof setup>>

type RuleOver = NonNullable<Parameters<typeof registry.makeRule>[3]>
const rule = (w: World, over: RuleOver = {}) =>
  registry.makeRule(w.user.id, w.bank.id, w.food.id, { amountPaise: 100_00n, ...over })

const occurrencesOf = (ruleId: string) =>
  prisma.recurringOccurrence.findMany({ where: { ruleId }, orderBy: { dueOn: "asc" } })
const datesOf = async (ruleId: string) => (await occurrencesOf(ruleId)).map((o) => fromDbDate(o.dueOn))
const nextDueOf = async (ruleId: string) => {
  const stored = await prisma.recurringRule.findUniqueOrThrow({ where: { id: ruleId } })
  return stored.nextDueOn === null ? null : fromDbDate(stored.nextDueOn)
}

describe("catching up a rule", () => {
  it("creates one pending occurrence per missed week, moves nextDueOn past today, and does nothing the second time", async () => {
    at("2026-05-19T06:00:00Z") // Tuesday 19 May in Kolkata
    const w = await setup()
    const r = await rule(w, { frequency: "WEEKLY", dayOfMonth: null, dayOfWeek: 3, startDate: "2026-04-29", nextDueOn: "2026-04-29" })

    expect(await generateDue(w.user.id)).toEqual({ created: 3, posted: 0 })
    expect(await datesOf(r.id)).toEqual(["2026-04-29", "2026-05-06", "2026-05-13"])
    expect((await occurrencesOf(r.id)).every((o) => o.status === "PENDING" && o.transactionId === null)).toBe(true)
    expect(await nextDueOf(r.id)).toBe("2026-05-20")

    expect(await generateDue(w.user.id)).toEqual({ created: 0, posted: 0 })
    expect(await occurrencesOf(r.id)).toHaveLength(3)
  })

  it("nothing is generated for a rule that is not yet due", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    const r = await rule(w, { nextDueOn: "2026-05-20", startDate: "2026-05-20" })
    expect(await generateDue(w.user.id)).toEqual({ created: 0, posted: 0 })
    expect(await occurrencesOf(r.id)).toEqual([])
    expect(await nextDueOf(r.id)).toBe("2026-05-20")
  })

  it("caps a run at 100 dates and carries on from where it stopped: 100, 100, 50, then nothing", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    const first = addDays(day("2026-05-19"), -249) // 250 days, today included
    const r = await rule(w, { frequency: "DAILY", dayOfMonth: null, startDate: first, nextDueOn: first })

    expect((await generateDue(w.user.id)).created).toBe(100)
    expect(await nextDueOf(r.id)).toBe(addDays(first, 100))
    expect((await generateDue(w.user.id)).created).toBe(100)
    expect((await generateDue(w.user.id)).created).toBe(50)
    expect((await generateDue(w.user.id)).created).toBe(0)

    const dates = await datesOf(r.id)
    expect(dates).toHaveLength(250)
    expect(dates).toEqual(Array.from({ length: 250 }, (_, i) => addDays(first, i)))
    expect(await nextDueOf(r.id)).toBe("2026-05-20")
  })

  it("keeps the month-end clamp: a day-31 rule from 31 January gives 31 Jan, 28 Feb, 31 Mar, 30 Apr", async () => {
    at("2026-05-01T06:00:00Z")
    const w = await setup()
    const r = await rule(w, { frequency: "MONTHLY", dayOfMonth: 31, startDate: "2026-01-31", nextDueOn: "2026-01-31" })
    expect((await generateDue(w.user.id)).created).toBe(4)
    expect(await datesOf(r.id)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"])
    expect(await nextDueOf(r.id)).toBe("2026-05-31")
  })

  it("stops at the occurrence limit and clears nextDueOn", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    const r = await rule(w, { frequency: "DAILY", dayOfMonth: null, startDate: "2026-05-10", nextDueOn: "2026-05-10", occurrenceLimit: 2 })
    expect((await generateDue(w.user.id)).created).toBe(2)
    expect(await datesOf(r.id)).toEqual(["2026-05-10", "2026-05-11"])
    expect(await nextDueOf(r.id)).toBeNull()
    expect((await generateDue(w.user.id)).created).toBe(0)
  })

  it("stops at the end date and clears nextDueOn", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    const r = await rule(w, {
      frequency: "DAILY",
      dayOfMonth: null,
      startDate: "2026-05-10",
      nextDueOn: "2026-05-10",
      endDate: toDbDate(day("2026-05-12")),
    })
    expect((await generateDue(w.user.id)).created).toBe(3)
    expect(await datesOf(r.id)).toEqual(["2026-05-10", "2026-05-11", "2026-05-12"])
    expect(await nextDueOf(r.id)).toBeNull()
  })

  it("clears nextDueOn, creating nothing, when an edit moved the end date behind it", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    const r = await rule(w, {
      frequency: "DAILY",
      dayOfMonth: null,
      startDate: "2026-05-01",
      nextDueOn: "2026-05-10",
      endDate: toDbDate(day("2026-05-09")),
    })
    expect(await generateDue(w.user.id)).toEqual({ created: 0, posted: 0 })
    expect(await occurrencesOf(r.id)).toEqual([])
    expect(await nextDueOf(r.id)).toBeNull()
  })

  it("three parallel runs leave exactly one set of occurrences and the right nextDueOn", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    const r = await rule(w, { frequency: "WEEKLY", dayOfMonth: null, dayOfWeek: 3, startDate: "2026-04-29", nextDueOn: "2026-04-29" })
    const results = await Promise.all([generateDue(w.user.id), generateDue(w.user.id), generateDue(w.user.id)])
    expect(results.reduce((sum, r2) => sum + r2.created, 0)).toBe(3)
    expect(await datesOf(r.id)).toEqual(["2026-04-29", "2026-05-06", "2026-05-13"])
    expect(await nextDueOf(r.id)).toBe("2026-05-20")
  })
})

describe("whose today it is (review focus 1)", () => {
  it("generates only the rules whose date is on or before the user's own today", async () => {
    // 10:30 UTC on 19 May: already 20 May in Kiritimati (UTC+14), still 18 May in Pago Pago (UTC-11).
    at("2026-05-19T10:30:00Z")
    const ahead = await setup("Pacific/Kiritimati")
    const behind = await setup("Pacific/Pago_Pago")
    const make = (w: World, dueOn: string) =>
      rule(w, { frequency: "DAILY", dayOfMonth: null, startDate: dueOn, nextDueOn: dueOn, occurrenceLimit: 1 })
    const aheadToday = await make(ahead, "2026-05-20") // the day after the UTC date: due for them
    const aheadLater = await make(ahead, "2026-05-21")
    const behindDue = await make(behind, "2026-05-18") // the day before the UTC date: due for them
    const behindNot = await make(behind, "2026-05-19") // the UTC date itself: not yet, for them

    expect(await generateDue(ahead.user.id)).toEqual({ created: 1, posted: 0 })
    expect(await generateDue(behind.user.id)).toEqual({ created: 1, posted: 0 })
    expect(await datesOf(aheadToday.id)).toEqual(["2026-05-20"])
    expect(await datesOf(aheadLater.id)).toEqual([])
    expect(await datesOf(behindDue.id)).toEqual(["2026-05-18"])
    expect(await datesOf(behindNot.id)).toEqual([])
    expect(await nextDueOf(aheadLater.id)).toBe("2026-05-21")
    expect(await nextDueOf(behindNot.id)).toBe("2026-05-19")
  })
})

describe("rules that must not generate", () => {
  it("an archived node: nothing is created and nextDueOn stays; once restored, every missed date catches up (review focus 3)", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    const r = await rule(w, { frequency: "DAILY", dayOfMonth: null, startDate: "2026-05-15", nextDueOn: "2026-05-15" })
    await prisma.ledgerNode.update({ where: { id: w.food.id }, data: { archivedAt: new Date() } })

    expect(await generateDue(w.user.id)).toEqual({ created: 0, posted: 0 })
    expect(await occurrencesOf(r.id)).toEqual([])
    expect(await nextDueOf(r.id)).toBe("2026-05-15")

    await prisma.ledgerNode.update({ where: { id: w.food.id }, data: { archivedAt: null } })
    expect((await generateDue(w.user.id)).created).toBe(5)
    expect(await datesOf(r.id)).toEqual(["2026-05-15", "2026-05-16", "2026-05-17", "2026-05-18", "2026-05-19"])
  })

  it("an archived source node is skipped the same way", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    const r = await rule(w, { startDate: "2026-05-01", nextDueOn: "2026-05-01" })
    await prisma.ledgerNode.update({ where: { id: w.bank.id }, data: { archivedAt: new Date() } })
    expect(await generateDue(w.user.id)).toEqual({ created: 0, posted: 0 })
    expect(await nextDueOf(r.id)).toBe("2026-05-01")
  })

  it("a paused rule and a deleted rule generate nothing", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    const paused = await rule(w, { startDate: "2026-05-01", nextDueOn: "2026-05-01", pausedAt: new Date() })
    const deleted = await rule(w, { startDate: "2026-05-01", nextDueOn: "2026-05-01", deletedAt: new Date() })
    expect(await generateDue(w.user.id)).toEqual({ created: 0, posted: 0 })
    expect(await occurrencesOf(paused.id)).toEqual([])
    expect(await occurrencesOf(deleted.id)).toEqual([])
    expect(await nextDueOf(paused.id)).toBe("2026-05-01")
  })

  it("never touches another user's rules", async () => {
    at("2026-05-19T06:00:00Z")
    const mine = await setup()
    const theirs = await setup()
    const r = await rule(theirs, { startDate: "2026-05-01", nextDueOn: "2026-05-01" })
    expect(await generateDue(mine.user.id)).toEqual({ created: 0, posted: 0 })
    expect(await occurrencesOf(r.id)).toEqual([])
  })
})

describe("auto-post", () => {
  const dailyAuto = (w: World, over: RuleOver = {}) =>
    rule(w, { frequency: "DAILY", dayOfMonth: null, startDate: "2026-05-17", nextDueOn: "2026-05-17", autoPost: true, ...over })
  const bankBalance = async (w: World) => (await sumBalances(w.user.id)).find((b) => b.nodeId === w.bank.id)!.balance

  it("posts each new occurrence once, under the key recurring:<id>, and a second run posts nothing more", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    const r = await dailyAuto(w)

    expect(await generateDue(w.user.id)).toEqual({ created: 3, posted: 3 })
    const occurrences = await occurrencesOf(r.id)
    expect(occurrences.map((o) => o.status)).toEqual(["POSTED", "POSTED", "POSTED"])
    for (const o of occurrences) {
      const transactions = await prisma.transaction.findMany({ where: { idempotencyKey: `recurring:${o.id}` } })
      expect(transactions).toHaveLength(1)
      expect(o.transactionId).toBe(transactions[0].id)
      expect(o.postFailure).toBeNull()
    }
    expect(await bankBalance(w)).toBe(1_000_00n - 300_00n)

    expect(await generateDue(w.user.id)).toEqual({ created: 0, posted: 0 })
    expect(await prisma.transaction.count({ where: { idempotencyKey: { startsWith: "recurring:" }, userId: w.user.id } })).toBe(3)
  })

  it("a rule that is not auto-post leaves its occurrences pending and writes no transaction", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    await dailyAuto(w, { autoPost: false })
    expect(await generateDue(w.user.id)).toEqual({ created: 3, posted: 0 })
    expect(await bankBalance(w)).toBe(1_000_00n)
  })

  it("an overdraft block leaves the occurrence pending with the service's own message", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    await prisma.ledgerNode.update({ where: { id: w.bank.id }, data: { blockNegative: true } })
    const r = await dailyAuto(w, { amountPaise: 600_00n, startDate: "2026-05-18", nextDueOn: "2026-05-18" })

    // Two of Rs 600 against Rs 1,000: the first posts, the second would overdraw the bank.
    expect(await generateDue(w.user.id)).toEqual({ created: 2, posted: 1 })
    const [first, second] = await occurrencesOf(r.id)
    expect(first.status).toBe("POSTED")
    expect(second.status).toBe("PENDING")
    expect(second.postFailure).toBe("Bank does not allow a negative balance, so this would overdraw it.")
    expect(second.transactionId).toBeNull()
  })

  it("an unknown error leaves it pending with the generic text and is logged; the next occurrence still posts", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await dailyAuto(w, { startDate: "2026-05-18", nextDueOn: "2026-05-18" })
    flaky.failNext = true

    expect(await generateDue(w.user.id)).toEqual({ created: 2, posted: 1 })
    const [first, second] = await occurrencesOf(r.id)
    expect(first).toMatchObject({ status: "PENDING", postFailure: "It could not be posted automatically." })
    expect(second.status).toBe("POSTED")
    expect(logged).toHaveBeenCalled()
  })
})

describe("honesty (EC-47)", () => {
  it("pending occurrences change no balance, net worth or cash flow", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    await rule(w, { frequency: "DAILY", dayOfMonth: null, startDate: "2026-05-10", nextDueOn: "2026-05-10" })
    const month = { kind: "month", year: 2026, month: 5 } as const
    const before = {
      balances: await sumBalances(w.user.id),
      dashboard: await getDashboard(w.user.id),
      flow: await loadCashFlow(w.user.id, month),
    }

    expect((await generateDue(w.user.id)).created).toBe(10)

    expect(await sumBalances(w.user.id)).toEqual(before.balances)
    expect(await getDashboard(w.user.id)).toEqual(before.dashboard)
    expect(await loadCashFlow(w.user.id, month)).toEqual(before.flow)
  })
})

describe("sweepAll and generateInBackground", () => {
  // Far in the past, so the sweep, which looks at every user in the database, finds only this file's rules.
  it("generates for every user with something due, and one user's failure is logged without stopping the others", async () => {
    at("2001-03-10T10:30:00Z") // already 11 March in Kiritimati
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const good = await setup()
    const ahead = await setup("Pacific/Kiritimati")
    const broken = await setup("Not/A_Zone") // its "today" cannot be worked out, so generating for it throws
    const dueToday = await rule(good, { frequency: "DAILY", dayOfMonth: null, startDate: "2001-03-09", nextDueOn: "2001-03-09" })
    const dueTomorrow = await rule(ahead, { frequency: "DAILY", dayOfMonth: null, startDate: "2001-03-11", nextDueOn: "2001-03-11" })
    const unreachable = await rule(broken, { startDate: "2001-03-01", nextDueOn: "2001-03-01" })

    await expect(sweepAll()).resolves.toBeUndefined()

    expect(await datesOf(dueToday.id)).toEqual(["2001-03-09", "2001-03-10"])
    expect(await datesOf(dueTomorrow.id)).toEqual(["2001-03-11"]) // the coarse bound (UTC date + 1) reached the UTC+14 user
    expect(await occurrencesOf(unreachable.id)).toEqual([])
    expect(logged).toHaveBeenCalled()
  })

  it("generateInBackground returns at once and does not throw, even when generating fails", async () => {
    at("2001-03-10T10:30:00Z")
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const broken = await setup("Not/A_Zone")
    expect(generateInBackground(broken.user.id)).toBeUndefined()
    await vi.waitFor(() => expect(logged).toHaveBeenCalled())
  })

  it("generateInBackground does generate", async () => {
    at("2026-05-19T06:00:00Z")
    const w = await setup()
    const r = await rule(w, { frequency: "DAILY", dayOfMonth: null, startDate: "2026-05-18", nextDueOn: "2026-05-18" })
    generateInBackground(w.user.id)
    await vi.waitFor(async () => expect(await occurrencesOf(r.id)).toHaveLength(2))
  })
})
