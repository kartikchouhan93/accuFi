import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { calendarDate, fromDbDate, type CalendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import * as repo from "@/server/repositories/recurring-repository"
import { inTransaction } from "@/server/repositories/unit-of-work"
import { createRegistry } from "./fixtures"

// The recurring repository against the real database: what is stored, what the conditional updates refuse, and the two
// operations the hourly sweep and a login can race on (the row lock and the duplicate-proof occurrence insert).

const registry = createRegistry()
afterAll(registry.cleanup)

type World = Awaited<ReturnType<typeof registry.makeWorld>>
let a: World
let b: World

beforeAll(async () => {
  a = await registry.makeWorld()
  b = await registry.makeWorld()
})

const d = (value: string) => calendarDate(value)
let keyCounter = 0
const uniqueKey = () => `rule-key-${Date.now()}-${keyCounter++}`

function ruleData(over: Partial<repo.RuleData> = {}): repo.RuleData {
  return {
    name: "Rent",
    fromNodeId: a.bank.id,
    toNodeId: a.food.id,
    amountPaise: 12_345n,
    note: "monthly",
    tags: ["home", "fixed"],
    frequency: "MONTHLY",
    interval: 1,
    dayOfMonth: 5,
    dayOfWeek: null,
    startDate: d("2026-04-05"),
    endDate: null,
    occurrenceLimit: null,
    autoPost: false,
    ...over,
  }
}

const withDue = (over: Partial<repo.RuleData> = {}, nextDueOn: CalendarDate | null = d("2026-04-05")) => ({
  ...ruleData(over),
  nextDueOn,
})

async function expectNotFound(promise: Promise<unknown>, entity: NotFoundError["entity"]) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error, "expected NotFoundError").toBeInstanceOf(NotFoundError)
  expect((error as NotFoundError).entity).toBe(entity)
}

describe("insertRule and reads", () => {
  it("stores the rule and reads it back with paise as bigint and the dates as stored days", async () => {
    const rule = await repo.insertRule(a.user.id, withDue({ endDate: d("2027-03-05"), occurrenceLimit: 12, autoPost: true }))
    expect(rule.userId).toBe(a.user.id)
    expect(rule.amountPaise).toBe(12_345n)
    expect(typeof rule.amountPaise).toBe("bigint")
    expect(rule.tags).toEqual(["home", "fixed"])
    expect(rule.version).toBe(0)
    expect(fromDbDate(rule.startDate)).toBe("2026-04-05")
    expect(rule.endDate && fromDbDate(rule.endDate)).toBe("2027-03-05")
    expect(rule.nextDueOn && fromDbDate(rule.nextDueOn)).toBe("2026-04-05")
    expect(rule.autoPost).toBe(true)
    expect(rule.occurrenceLimit).toBe(12)
    expect(rule.deletedAt).toBeNull()
    expect(rule.pausedAt).toBeNull()

    const found = await repo.findRuleById(a.user.id, rule.id)
    expect(found).toEqual(rule)
    expect(await inTransaction((uow) => repo.findRuleById(a.user.id, rule.id, uow))).toEqual(rule)
  })

  it("refuses a node that is not the user's, as not-found, and writes nothing", async () => {
    const before = await prisma.recurringRule.count({ where: { userId: a.user.id } })
    await expectNotFound(repo.insertRule(a.user.id, withDue({ toNodeId: b.food.id })), "node")
    await expectNotFound(repo.insertRule(a.user.id, withDue({ fromNodeId: b.bank.id })), "node")
    await expectNotFound(inTransaction((uow) => repo.insertRule(a.user.id, withDue({ toNodeId: b.food.id }), uow)), "node")
    expect(await prisma.recurringRule.count({ where: { userId: a.user.id } })).toBe(before)
  })

  it("throws DuplicateRuleKeyError carrying the stored row when an idempotency key repeats", async () => {
    const idempotencyKey = uniqueKey()
    const first = await repo.insertRule(a.user.id, { ...withDue(), idempotencyKey })
    const error = await repo.insertRule(a.user.id, { ...withDue({ name: "Other" }), idempotencyKey }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(repo.DuplicateRuleKeyError)
    expect((error as repo.DuplicateRuleKeyError).existing).toEqual(first)
    expect(await prisma.recurringRule.count({ where: { userId: a.user.id, idempotencyKey } })).toBe(1)
    // the same key for another user is a different key
    const other = await repo.insertRule(b.user.id, {
      ...withDue({ fromNodeId: b.bank.id, toNodeId: b.food.id }),
      idempotencyKey,
    })
    expect(other.id).not.toBe(first.id)
  })

  it("lists live rules with the soonest next due first, finished ones last, then by name", async () => {
    const w = await registry.makeWorld()
    const mk = (name: string, nextDueOn: CalendarDate | null) =>
      repo.insertRule(w.user.id, { ...withDue({ name, fromNodeId: w.bank.id, toNodeId: w.food.id }, nextDueOn) })
    await mk("Zeta", d("2026-05-01"))
    await mk("Finished", null)
    await mk("Beta", d("2026-06-01"))
    await mk("Alpha", d("2026-06-01"))
    await mk("Sooner", d("2026-04-15"))
    const deleted = await mk("Deleted", d("2026-01-01"))
    await inTransaction((uow) => repo.softDeleteRule(w.user.id, deleted.id, uow))

    const names = (await repo.findRules(w.user.id)).map((r) => r.name)
    expect(names).toEqual(["Sooner", "Zeta", "Alpha", "Beta", "Finished"])
  })
})

describe("updateRule", () => {
  it("applies the changes, bumps the version and converts the dates", async () => {
    const rule = await repo.insertRule(a.user.id, withDue())
    const updated = await repo.updateRule(a.user.id, rule.id, 0, {
      name: "Rent 2",
      amountPaise: 99n,
      nextDueOn: d("2026-05-05"),
      endDate: d("2027-01-01"),
      tags: [],
      pausedAt: new Date("2026-04-10T00:00:00Z"),
    })
    expect(updated.version).toBe(1)
    expect(updated.name).toBe("Rent 2")
    expect(updated.amountPaise).toBe(99n)
    expect(updated.tags).toEqual([])
    expect(updated.nextDueOn && fromDbDate(updated.nextDueOn)).toBe("2026-05-05")
    expect(updated.endDate && fromDbDate(updated.endDate)).toBe("2027-01-01")
    expect(updated.pausedAt).not.toBeNull()
    // untouched fields stay
    expect(updated.note).toBe("monthly")
    expect(updated.dayOfMonth).toBe(5)

    const cleared = await repo.updateRule(a.user.id, rule.id, 1, { nextDueOn: null, pausedAt: null, endDate: null })
    expect(cleared.version).toBe(2)
    expect(cleared.nextDueOn).toBeNull()
    expect(cleared.pausedAt).toBeNull()
    expect(cleared.endDate).toBeNull()
  })

  it("throws RuleVersionConflictError with the stored row for a stale version, and leaves the row", async () => {
    const rule = await repo.insertRule(a.user.id, withDue())
    await repo.updateRule(a.user.id, rule.id, 0, { name: "First" })
    const stored = await prisma.recurringRule.findUniqueOrThrow({ where: { id: rule.id } })
    const error = await repo.updateRule(a.user.id, rule.id, 0, { name: "Stale" }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(repo.RuleVersionConflictError)
    expect((error as repo.RuleVersionConflictError).current).toEqual(stored)
    expect(await prisma.recurringRule.findUniqueOrThrow({ where: { id: rule.id } })).toEqual(stored)
  })

  it("is not-found for an unknown or deleted rule, and checks a changed node is the user's", async () => {
    const rule = await repo.insertRule(a.user.id, withDue())
    await expectNotFound(repo.updateRule(a.user.id, "no-such-rule", 0, { name: "x" }), "rule")
    await expectNotFound(repo.updateRule(a.user.id, rule.id, 0, { toNodeId: b.food.id }), "node")
    expect((await prisma.recurringRule.findUniqueOrThrow({ where: { id: rule.id } })).version).toBe(0)
    await inTransaction((uow) => repo.softDeleteRule(a.user.id, rule.id, uow))
    await expectNotFound(repo.updateRule(a.user.id, rule.id, 1, { name: "x" }), "rule")
  })
})

describe("softDeleteRule and lockRule", () => {
  it("hides the rule and removes only its PENDING occurrences", async () => {
    const rule = await repo.insertRule(a.user.id, withDue())
    const tx = await registry.makeTransaction(a.user.id, a.bank.id, a.food.id)
    await registry.makeOccurrence(a.user.id, rule.id, "2026-04-05")
    await registry.makeOccurrence(a.user.id, rule.id, "2026-05-05")
    const posted = await registry.makeOccurrence(a.user.id, rule.id, "2026-06-05", {
      status: "POSTED",
      transactionId: tx.id,
      resolvedAt: new Date(),
    })
    const dismissed = await registry.makeOccurrence(a.user.id, rule.id, "2026-07-05", { status: "DISMISSED", resolvedAt: new Date() })

    await inTransaction((uow) => repo.softDeleteRule(a.user.id, rule.id, uow))

    expect(await repo.findRuleById(a.user.id, rule.id)).toBeNull()
    expect((await repo.findRules(a.user.id)).map((r) => r.id)).not.toContain(rule.id)
    const left = await prisma.recurringOccurrence.findMany({ where: { ruleId: rule.id }, orderBy: { dueOn: "asc" } })
    expect(left.map((o) => o.id)).toEqual([posted.id, dismissed.id])
    const stored = await prisma.recurringRule.findUniqueOrThrow({ where: { id: rule.id } })
    expect(stored.deletedAt).not.toBeNull()
    expect(stored.version).toBe(1)
    // a second delete is not-found
    await expectNotFound(inTransaction((uow) => repo.softDeleteRule(a.user.id, rule.id, uow)), "rule")
  })

  it("lockRule returns the live rule, and null for a deleted or unknown one", async () => {
    const rule = await repo.insertRule(a.user.id, withDue())
    const locked = await inTransaction((uow) => repo.lockRule(a.user.id, rule.id, uow))
    expect(locked).toEqual(rule)
    expect(await inTransaction((uow) => repo.lockRule(a.user.id, "no-such-rule", uow))).toBeNull()
    await inTransaction((uow) => repo.softDeleteRule(a.user.id, rule.id, uow))
    expect(await inTransaction((uow) => repo.lockRule(a.user.id, rule.id, uow))).toBeNull()
  })

  it("lockRule makes a second transaction wait until the first ends", async () => {
    const rule = await repo.insertRule(a.user.id, withDue())
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let acquired!: () => void
    const firstHasLock = new Promise<void>((resolve) => (acquired = resolve))

    const first = inTransaction(async (uow) => {
      await repo.lockRule(a.user.id, rule.id, uow)
      acquired()
      await held
      order.push("first done")
    })
    await firstHasLock
    const second = inTransaction(async (uow) => {
      await repo.lockRule(a.user.id, rule.id, uow)
      order.push("second locked")
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(order).toEqual([])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(["first done", "second locked"])
  })
})

describe("findDueRules and findUsersWithRulesDueBy", () => {
  it("honours through, pause, finished and deletion", async () => {
    const w = await registry.makeWorld()
    const mk = (name: string, nextDueOn: CalendarDate | null, extra: Partial<Parameters<typeof prisma.recurringRule.update>[0]["data"]> = {}) =>
      repo
        .insertRule(w.user.id, withDue({ name, fromNodeId: w.bank.id, toNodeId: w.food.id }, nextDueOn))
        .then(async (rule) => (Object.keys(extra).length > 0 ? prisma.recurringRule.update({ where: { id: rule.id }, data: extra }) : rule))
    const early = await mk("early", d("2026-04-01"))
    const onDay = await mk("on the day", d("2026-04-10"))
    await mk("later", d("2026-04-11"))
    await mk("paused", d("2026-04-02"), { pausedAt: new Date() })
    await mk("finished", null)
    await mk("deleted", d("2026-04-03"), { deletedAt: new Date() })

    const due = await repo.findDueRules(w.user.id, d("2026-04-10"))
    expect(due.map((r) => r.id)).toEqual([early.id, onDay.id])
    expect(await inTransaction((uow) => repo.findDueRules(w.user.id, d("2026-04-10"), uow))).toEqual(due)
    expect(await repo.findDueRules(w.user.id, d("2026-03-31"))).toEqual([])
  })

  it("lists the users with a live, unpaused rule due, once each", async () => {
    const x = await registry.makeWorld()
    const y = await registry.makeWorld()
    const z = await registry.makeWorld()
    for (const [w, count] of [[x, 2], [y, 1]] as const) {
      for (let i = 0; i < count; i++) {
        await repo.insertRule(w.user.id, withDue({ fromNodeId: w.bank.id, toNodeId: w.food.id }, d("2026-04-01")))
      }
    }
    // z has a rule, but it is paused
    const paused = await repo.insertRule(z.user.id, withDue({ fromNodeId: z.bank.id, toNodeId: z.food.id }, d("2026-04-01")))
    await prisma.recurringRule.update({ where: { id: paused.id }, data: { pausedAt: new Date() } })

    const users = await repo.findUsersWithRulesDueBy(d("2026-04-01"))
    expect(users).toContain(x.user.id)
    expect(users).toContain(y.user.id)
    expect(users).not.toContain(z.user.id)
    expect(users.filter((id) => id === x.user.id)).toHaveLength(1)
    // nothing is due before the rules' first day, for these users
    const earlier = await repo.findUsersWithRulesDueBy(d("2026-03-31"))
    expect(earlier).not.toContain(x.user.id)
  })
})

describe("insertOccurrences", () => {
  const dueDays = (rows: { dueOn: Date }[]) => rows.map((r) => fromDbDate(r.dueOn)).sort()

  it("inserts pending rows, and a second call with overlapping dates returns only the new ones", async () => {
    const rule = await repo.insertRule(a.user.id, withDue())
    const first = await inTransaction((uow) =>
      repo.insertOccurrences(a.user.id, rule.id, [d("2026-04-05"), d("2026-05-05"), d("2026-06-05")], uow),
    )
    expect(dueDays(first)).toEqual(["2026-04-05", "2026-05-05", "2026-06-05"])
    expect(first.every((o) => o.status === "PENDING" && o.userId === a.user.id && o.ruleId === rule.id)).toBe(true)
    expect(first.every((o) => o.transactionId === null && o.resolvedAt === null && o.postFailure === null)).toBe(true)
    expect(new Set(first.map((o) => o.id)).size).toBe(3)

    const second = await inTransaction((uow) =>
      repo.insertOccurrences(a.user.id, rule.id, [d("2026-06-05"), d("2026-07-05"), d("2026-05-05"), d("2026-08-05"), d("2026-07-05")], uow),
    )
    expect(dueDays(second)).toEqual(["2026-07-05", "2026-08-05"])

    const none = await inTransaction((uow) => repo.insertOccurrences(a.user.id, rule.id, [d("2026-04-05")], uow))
    expect(none).toEqual([])
    expect(await inTransaction((uow) => repo.insertOccurrences(a.user.id, rule.id, [], uow))).toEqual([])

    expect(await repo.countOccurrences(a.user.id, rule.id)).toBe(5)
    expect(await prisma.recurringOccurrence.count({ where: { ruleId: rule.id } })).toBe(5)
  })

  it("returns only the rows each overlapping concurrent call inserted: every date exactly once across both", async () => {
    for (let round = 0; round < 5; round++) {
      const rule = await repo.insertRule(a.user.id, withDue())
      const all = ["2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"].map(d)
      const [left, right] = await Promise.all([
        inTransaction((uow) => repo.insertOccurrences(a.user.id, rule.id, all.slice(0, 5), uow)),
        inTransaction((uow) => repo.insertOccurrences(a.user.id, rule.id, all.slice(1), uow)),
      ])
      const returned = [...left, ...right].map((o) => fromDbDate(o.dueOn)).sort()
      expect(returned, `round ${round}: each date is inserted by exactly one call`).toEqual([...all].sort())
      expect(new Set([...left, ...right].map((o) => o.id)).size).toBe(6)
      expect(await prisma.recurringOccurrence.count({ where: { ruleId: rule.id } })).toBe(6)
    }
  })

  it("is not-found for a rule that is not the user's or is deleted, and inserts nothing", async () => {
    const mine = await repo.insertRule(a.user.id, withDue())
    const theirs = await repo.insertRule(b.user.id, withDue({ fromNodeId: b.bank.id, toNodeId: b.food.id }))
    await expectNotFound(inTransaction((uow) => repo.insertOccurrences(a.user.id, theirs.id, [d("2026-04-05")], uow)), "rule")
    await inTransaction((uow) => repo.softDeleteRule(a.user.id, mine.id, uow))
    await expectNotFound(inTransaction((uow) => repo.insertOccurrences(a.user.id, mine.id, [d("2026-04-05")], uow)), "rule")
    expect(await prisma.recurringOccurrence.count({ where: { ruleId: { in: [mine.id, theirs.id] } } })).toBe(0)
  })
})

describe("occurrence reads and state changes", () => {
  async function pendingOne(dueOn = "2026-04-05") {
    const rule = await repo.insertRule(a.user.id, withDue())
    const [occurrence] = await inTransaction((uow) => repo.insertOccurrences(a.user.id, rule.id, [d(dueOn)], uow))
    return { rule, occurrence }
  }

  it("findOccurrenceById returns the occurrence with its rule", async () => {
    const { rule, occurrence } = await pendingOne()
    const found = await repo.findOccurrenceById(a.user.id, occurrence.id)
    expect(found).toEqual({ ...occurrence, rule })
    expect(await inTransaction((uow) => repo.findOccurrenceById(a.user.id, occurrence.id, uow))).toEqual(found)
    expect(await repo.findOccurrenceById(a.user.id, "no-such-occurrence")).toBeNull()
  })

  it("markPosted links the transaction once; the second call returns null", async () => {
    const { occurrence } = await pendingOne()
    await repo.setPostFailure(a.user.id, occurrence.id, "Insufficient balance")
    const tx = await registry.makeTransaction(a.user.id, a.bank.id, a.food.id)
    const posted = await repo.markPosted(a.user.id, occurrence.id, tx.id)
    expect(posted).not.toBeNull()
    expect(posted?.status).toBe("POSTED")
    expect(posted?.transactionId).toBe(tx.id)
    expect(posted?.postFailure).toBeNull()
    expect(posted?.resolvedAt).not.toBeNull()

    const tx2 = await registry.makeTransaction(a.user.id, a.bank.id, a.food.id)
    expect(await repo.markPosted(a.user.id, occurrence.id, tx2.id)).toBeNull()
    const stored = await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })
    expect(stored.transactionId).toBe(tx.id)
    // a POSTED occurrence cannot be dismissed or put back
    expect(await repo.markDismissed(a.user.id, occurrence.id)).toBeNull()
    expect(await repo.markPending(a.user.id, occurrence.id)).toBeNull()
  })

  it("markPosted refuses a transaction that is not the user's", async () => {
    const { occurrence } = await pendingOne()
    await expectNotFound(repo.markPosted(a.user.id, occurrence.id, b.tx.id), "transaction")
    expect((await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).status).toBe("PENDING")
  })

  it("markDismissed then markPending round-trips", async () => {
    const { occurrence } = await pendingOne()
    const dismissed = await repo.markDismissed(a.user.id, occurrence.id)
    expect(dismissed?.status).toBe("DISMISSED")
    expect(dismissed?.resolvedAt).not.toBeNull()
    expect(await repo.markDismissed(a.user.id, occurrence.id)).toBeNull()

    const back = await repo.markPending(a.user.id, occurrence.id)
    expect(back?.status).toBe("PENDING")
    expect(back?.resolvedAt).toBeNull()
    expect(await repo.markPending(a.user.id, occurrence.id)).toBeNull()
  })

  it("setPostFailure sets and clears the text only while pending", async () => {
    const { occurrence } = await pendingOne()
    await repo.setPostFailure(a.user.id, occurrence.id, "Insufficient balance")
    expect((await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).postFailure).toBe("Insufficient balance")
    await repo.setPostFailure(a.user.id, occurrence.id, null)
    expect((await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).postFailure).toBeNull()

    await repo.markDismissed(a.user.id, occurrence.id)
    await repo.setPostFailure(a.user.id, occurrence.id, "ignored")
    expect((await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).postFailure).toBeNull()
  })

  it("lists the pending inbox oldest first, counts it, and leaves out a deleted rule's", async () => {
    const w = await registry.makeWorld()
    const mk = (name: string) =>
      repo.insertRule(w.user.id, withDue({ name, fromNodeId: w.bank.id, toNodeId: w.food.id }))
    const live = await mk("live")
    const gone = await mk("gone")
    const [late, early] = [
      ...(await inTransaction((uow) => repo.insertOccurrences(w.user.id, live.id, [d("2026-06-05"), d("2026-04-05")], uow))),
    ].sort((x, y) => y.dueOn.getTime() - x.dueOn.getTime())
    await inTransaction((uow) => repo.insertOccurrences(w.user.id, gone.id, [d("2026-03-05")], uow))
    await registry.makeOccurrence(w.user.id, live.id, "2026-05-05", { status: "DISMISSED", resolvedAt: new Date() })
    // a deleted rule's pending occurrences are removed by softDeleteRule, but a stray one must not show either
    await prisma.recurringRule.update({ where: { id: gone.id }, data: { deletedAt: new Date() } })

    const pending = await repo.findPending(w.user.id)
    expect(pending.map((o) => o.id)).toEqual([early.id, late.id])
    expect(pending.every((o) => o.rule.id === live.id)).toBe(true)
    expect(await repo.countPending(w.user.id)).toBe(2)
  })

  it("lists recently handled occurrences, posted and dismissed, newest resolved first and limited", async () => {
    const w = await registry.makeWorld()
    const rule = await repo.insertRule(w.user.id, withDue({ fromNodeId: w.bank.id, toNodeId: w.food.id }))
    const tx = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id)
    const oldest = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-05", { status: "DISMISSED", resolvedAt: new Date("2026-04-06T00:00:00Z") })
    const newest = await registry.makeOccurrence(w.user.id, rule.id, "2026-05-05", { status: "POSTED", transactionId: tx.id, resolvedAt: new Date("2026-05-06T00:00:00Z") })
    const middle = await registry.makeOccurrence(w.user.id, rule.id, "2026-06-05", { status: "DISMISSED", resolvedAt: new Date("2026-05-01T00:00:00Z") })
    await registry.makeOccurrence(w.user.id, rule.id, "2026-07-05")

    const all = await repo.findRecentlyHandled(w.user.id, 10)
    expect(all.map((o) => o.id)).toEqual([newest.id, middle.id, oldest.id])
    expect(all.every((o) => o.rule.id === rule.id)).toBe(true)
    expect((await repo.findRecentlyHandled(w.user.id, 2)).map((o) => o.id)).toEqual([newest.id, middle.id])
  })
})
