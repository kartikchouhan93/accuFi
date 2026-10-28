import { randomUUID } from "node:crypto"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { calendarDate, fromDbDate } from "@/domain/calendar-date"
import { datesDue } from "@/domain/recurrence"
import { scheduleOfRule } from "@/lib/recurring-view"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import * as recurringRepo from "@/server/repositories/recurring-repository"
import { findRules, RuleVersionConflictError } from "@/server/repositories/recurring-repository"
import { updateNode } from "@/server/repositories/node-repository"
import { dismissOccurrence, postOccurrence } from "@/server/services/occurrence-service"
import { generateDue } from "@/server/services/recurring-generation"
import {
  createRule,
  deleteRule,
  editRule,
  InvalidRuleError,
  setPaused,
  type RuleInput,
} from "@/server/services/recurring-service"
import { createRegistry } from "../repositories/fixtures"

// The rule lifecycle against the real database. "Today" is moved with a fake Date (nothing else), which `todayFor` reads:
// 19 May 2026 is a Tuesday in Kolkata and in New York alike, so both zone runs see the same day.

const registry = createRegistry()
afterAll(registry.cleanup)
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) })
const day = (value: string) => calendarDate(value)
const TODAY = "2026-05-19T06:00:00Z"

/** A user with Rs 1,000.00 in a bank, an expense node, a salary source and one investment of each valuation mode. */
async function setup() {
  const user = await registry.makeUser()
  const income = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  const gold = await registry.makeNode(user.id, "INVESTMENT", "Gold", { valuationMode: "QUANTITY", unitLabel: "g" })
  const flat = await registry.makeNode(user.id, "INVESTMENT", "Flat", { valuationMode: "LUMP" })
  await registry.makeTransaction(user.id, income.id, bank.id, { amountPaise: 1_000_00n, occurredAt: "2000-01-01" })
  return { user, income, bank, food, gold, flat }
}
type World = Awaited<ReturnType<typeof setup>>

const monthly = (w: World, over: Partial<RuleInput> = {}): RuleInput & { idempotencyKey: string } => ({
  name: "Rent",
  fromNodeId: w.bank.id,
  toNodeId: w.food.id,
  amount: 100_00n,
  frequency: "MONTHLY",
  interval: 1,
  startDate: day("2026-06-01"),
  autoPost: false,
  idempotencyKey: randomUUID(),
  ...over,
})

/** The edit form's fields: the rule's own, with `nextDue` where the start date was. */
const editOf = (w: World, nextDue: string, over: Partial<Omit<RuleInput, "startDate">> = {}) => ({
  name: "Rent",
  fromNodeId: w.bank.id,
  toNodeId: w.food.id,
  amount: 100_00n,
  frequency: "MONTHLY" as const,
  interval: 1,
  autoPost: false,
  ...over,
  nextDue: day(nextDue),
})

const occurrencesOf = (ruleId: string) =>
  prisma.recurringOccurrence.findMany({ where: { ruleId }, orderBy: { dueOn: "asc" } })
const datesOf = async (ruleId: string) => (await occurrencesOf(ruleId)).map((o) => fromDbDate(o.dueOn))
const storedRule = (id: string) => prisma.recurringRule.findUniqueOrThrow({ where: { id } })

/** The fields a refusal was filed under, and the whole refusal for a message check. */
async function refusal(work: Promise<unknown>): Promise<InvalidRuleError> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(InvalidRuleError)
  return error as InvalidRuleError
}
const fieldsOf = (error: InvalidRuleError) => error.violations.map((v) => v.field)

describe("createRule", () => {
  it("brings the inbox up to date at once: a weekly rule that started 10 days ago has two pending entries and a future next due", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(w.user.id, monthly(w, { frequency: "WEEKLY", startDate: day("2026-05-09") }))

    expect(await datesOf(view.id)).toEqual(["2026-05-09", "2026-05-16"])
    expect((await occurrencesOf(view.id)).every((o) => o.status === "PENDING")).toBe(true)
    expect(view.nextDueOn).toBe("2026-05-23")
    expect(view.state).toBe("active")
    expect(view.dayOfWeek).toBe(6) // the weekday of the start date, stored explicitly
    expect(view.scheduleText).toBe("Weekly on Saturday")
    expect(view.amountPaise).toBe("10000")
    expect(view.fromName).toBe("Bank")
    expect(view.toName).toBe("Food")
  })

  it("trims the note and tags, and drops duplicate tags", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(w.user.id, monthly(w, { note: "  flat rent ", tags: ["home", " home ", "fixed", ""] }))
    expect(view.note).toBe("flat rent")
    expect(view.tags).toEqual(["home", "fixed"])
  })

  it("refuses autoPost into an investment valued by quantity, under autoPost, and allows it into a lump", async () => {
    at(TODAY)
    const w = await setup()
    const refused = await refusal(createRule(w.user.id, monthly(w, { toNodeId: w.gold.id, autoPost: true })))
    expect(fieldsOf(refused)).toEqual(["autoPost"])
    expect(await prisma.recurringRule.count({ where: { userId: w.user.id } })).toBe(0)

    // The same rule without autoPost is fine: it is only the automatic post that cannot supply a quantity.
    await expect(createRule(w.user.id, monthly(w, { toNodeId: w.gold.id, autoPost: false }))).resolves.toMatchObject({ autoPost: false })
    await expect(createRule(w.user.id, monthly(w, { toNodeId: w.flat.id, autoPost: true }))).resolves.toMatchObject({ autoPost: true })
  })

  it("refuses an illegal flow, the same node and an archived end, each under the field to fix, and writes nothing", async () => {
    at(TODAY)
    const w = await setup()
    const archivedSource = await registry.makeNode(w.user.id, "ASSET", "Old bank", { archivedAt: new Date() })
    const archivedTarget = await registry.makeNode(w.user.id, "EXPENSE", "Old shop", { archivedAt: new Date() })

    expect(fieldsOf(await refusal(createRule(w.user.id, monthly(w, { toNodeId: w.income.id }))))).toEqual(["toNodeId"])
    expect(fieldsOf(await refusal(createRule(w.user.id, monthly(w, { toNodeId: w.bank.id }))))).toEqual(["toNodeId"])
    expect(fieldsOf(await refusal(createRule(w.user.id, monthly(w, { fromNodeId: archivedSource.id }))))).toEqual(["fromNodeId"])
    expect(fieldsOf(await refusal(createRule(w.user.id, monthly(w, { toNodeId: archivedTarget.id }))))).toEqual(["toNodeId"])
    expect(fieldsOf(await refusal(createRule(w.user.id, monthly(w, { amount: 0n }))))).toEqual(["amount"])
    expect(await prisma.recurringRule.count({ where: { userId: w.user.id } })).toBe(0)
  })

  it("refuses a bad schedule under the schedule's field", async () => {
    at(TODAY)
    const w = await setup()
    const error = await refusal(
      createRule(w.user.id, monthly(w, { interval: 0, endDate: day("2026-05-01"), occurrenceLimit: 0 })),
    )
    expect(fieldsOf(error).sort()).toEqual(["endDate", "interval", "occurrenceLimit"])
  })

  it("refuses a start date that would make more than 100 entries due now", async () => {
    at(TODAY)
    const w = await setup()
    const error = await refusal(createRule(w.user.id, monthly(w, { frequency: "DAILY", startDate: day("2025-04-14") })))
    expect(fieldsOf(error)).toEqual(["startDate"])
    expect(error.violations[0].message).toMatch(/100/)
    expect(error.violations[0].message).toMatch(/choose a later start date/i)
    expect(await prisma.recurringRule.count({ where: { userId: w.user.id } })).toBe(0)

    // Exactly 100 due is allowed: 100 days ago to today inclusive is 101 days, so start 99 days back.
    await expect(createRule(w.user.id, monthly(w, { frequency: "DAILY", startDate: day("2026-02-09") }))).resolves.toBeDefined()
  })

  it("answers a repeated key with the stored rule and writes one row", async () => {
    at(TODAY)
    const w = await setup()
    const input = monthly(w, { frequency: "WEEKLY", startDate: day("2026-05-09") })
    const first = await createRule(w.user.id, input)
    const again = await createRule(w.user.id, input)
    expect(again.id).toBe(first.id)
    expect(await prisma.recurringRule.count({ where: { userId: w.user.id } })).toBe(1)
    expect(await occurrencesOf(first.id)).toHaveLength(2)
  })

  it("is not found for a node that is another user's", async () => {
    at(TODAY)
    const w = await setup()
    const other = await setup()
    await expect(createRule(w.user.id, monthly(w, { toNodeId: other.food.id }))).rejects.toBeInstanceOf(NotFoundError)
  })
})

// A replay is the answer to a request already made, however long ago: it is looked up first and never re-validated, since
// the world may have moved on (a node archived, today later) and refusing would tell a user their saved rule failed.
describe("createRule replays", () => {
  it("returns the stored rule when the destination has been archived since, and stores one row", async () => {
    at(TODAY)
    const w = await setup()
    const input = monthly(w, { frequency: "WEEKLY", startDate: day("2026-05-09") })
    const first = await createRule(w.user.id, input)
    await updateNode(w.user.id, w.food.id, { archivedAt: new Date() })

    const again = await createRule(w.user.id, input)
    expect(again.id).toBe(first.id)
    expect(again.state).toBe("blocked") // as the rules screen now shows it, not refused
    expect(await prisma.recurringRule.count({ where: { userId: w.user.id } })).toBe(1)
  })

  it("returns the stored rule when its start date would now make more than 100 entries due", async () => {
    at(TODAY)
    const w = await setup()
    // Exactly 100 due on the day it was made: 99 days back to today.
    const input = monthly(w, { frequency: "DAILY", startDate: day("2026-02-09") })
    const first = await createRule(w.user.id, input)
    expect(await occurrencesOf(first.id)).toHaveLength(100)

    at("2026-06-18T06:00:00Z") // a month on: the same input would now be 130 due and is refused as a new rule
    await refusal(createRule(w.user.id, { ...input, idempotencyKey: randomUUID() }))
    const again = await createRule(w.user.id, input)
    expect(again.id).toBe(first.id)
    expect(await prisma.recurringRule.count({ where: { userId: w.user.id } })).toBe(1)
  })

  it("makes sure what is due has been generated for the stored rule, and answers with it as it then is", async () => {
    at(TODAY)
    const w = await setup()
    const input = monthly(w, { frequency: "WEEKLY", startDate: day("2026-05-09") })
    const first = await createRule(w.user.id, input)
    expect(await datesOf(first.id)).toEqual(["2026-05-09", "2026-05-16"])

    at("2026-05-25T06:00:00Z") // the 23rd has fallen due since
    const again = await createRule(w.user.id, input)
    expect(await datesOf(first.id)).toEqual(["2026-05-09", "2026-05-16", "2026-05-23"])
    expect(again.nextDueOn).toBe("2026-05-30")
    expect(again.version).toBe((await storedRule(first.id)).version)
    expect(await prisma.recurringRule.count({ where: { userId: w.user.id } })).toBe(1)
  })

  it("does not hand back a deleted rule as if it were live: it is refused, under the request key, and nothing is made", async () => {
    at(TODAY)
    const w = await setup()
    const input = monthly(w)
    const first = await createRule(w.user.id, input)
    await deleteRule(w.user.id, first.id)

    const error = await refusal(createRule(w.user.id, input))
    expect(fieldsOf(error)).toEqual(["idempotencyKey"])
    expect(error.message).toMatch(/already created and then deleted/i)
    expect(await prisma.recurringRule.count({ where: { userId: w.user.id } })).toBe(1)
    expect((await storedRule(first.id)).deletedAt).not.toBeNull()
  })

  it("the loser of a race answers with the rule after generation, not as it was inserted", async () => {
    at(TODAY)
    const w = await setup()
    const input = monthly(w, { frequency: "WEEKLY", startDate: day("2026-05-09") })
    const winner = await createRule(w.user.id, input)
    expect(winner.version).toBeGreaterThan(0) // generation moved the next due day, which bumps the version

    // The loser looked, found nothing, and then collided on insert, holding the row as it was when inserted.
    const asInserted = { ...(await storedRule(winner.id)), version: 0, nextDueOn: new Date("2026-05-09T00:00:00Z") }
    vi.spyOn(recurringRepo, "findRuleByKey").mockResolvedValueOnce(null)
    vi.spyOn(recurringRepo, "insertRule").mockRejectedValueOnce(new recurringRepo.DuplicateRuleKeyError(asInserted))

    const loser = await createRule(w.user.id, input)
    expect(loser.id).toBe(winner.id)
    expect(loser.version).toBe(winner.version)
    expect(loser.nextDueOn).toBe(winner.nextDueOn)
    expect(await prisma.recurringRule.count({ where: { userId: w.user.id } })).toBe(1)
  })

  it("two submits at once make one rule, and both answers are the rule after generation", async () => {
    at(TODAY)
    const w = await setup()
    const input = monthly(w, { frequency: "WEEKLY", startDate: day("2026-05-09") })
    const [one, two] = await Promise.all([createRule(w.user.id, input), createRule(w.user.id, input)])
    expect(one.id).toBe(two.id)
    expect(await prisma.recurringRule.count({ where: { userId: w.user.id } })).toBe(1)
    expect(await occurrencesOf(one.id)).toHaveLength(2)
    const stored = await storedRule(one.id)
    for (const view of [one, two]) {
      expect(view.version).toBe(stored.version)
      expect(view.nextDueOn).toBe("2026-05-23")
    }
  })

  it("does not answer one user's key with another user's rule", async () => {
    at(TODAY)
    const w = await setup()
    const other = await setup()
    const theirs = await createRule(other.user.id, monthly(other))
    const key = (await storedRule(theirs.id)).idempotencyKey!
    const mine = await createRule(w.user.id, { ...monthly(w), idempotencyKey: key })
    expect(mine.id).not.toBe(theirs.id)
    expect(await prisma.recurringRule.count({ where: { userId: w.user.id } })).toBe(1)
  })
})

describe("editRule", () => {
  it("conflicts when the version is stale, and changes nothing", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(w.user.id, monthly(w))
    await editRule(w.user.id, view.id, view.version, editOf(w, "2026-06-01", { name: "Flat rent" }))
    await expect(editRule(w.user.id, view.id, view.version, editOf(w, "2026-06-01", { name: "Other" }))).rejects.toBeInstanceOf(
      RuleVersionConflictError,
    )
    expect((await storedRule(view.id)).name).toBe("Flat rent")
  })

  it("is not found for another user's rule", async () => {
    at(TODAY)
    const w = await setup()
    const other = await setup()
    const view = await createRule(other.user.id, monthly(other))
    await expect(editRule(w.user.id, view.id, view.version, editOf(w, "2026-06-01"))).rejects.toBeInstanceOf(NotFoundError)
    await expect(setPaused(w.user.id, view.id, true)).rejects.toBeInstanceOf(NotFoundError)
    await expect(deleteRule(w.user.id, view.id)).rejects.toBeInstanceOf(NotFoundError)
  })

  it("validates the template and the schedule as creating does", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(w.user.id, monthly(w))
    const error = await refusal(
      editRule(w.user.id, view.id, view.version, editOf(w, "2026-06-01", { toNodeId: w.gold.id, autoPost: true, interval: 0 })),
    )
    expect(fieldsOf(error).sort()).toEqual(["autoPost", "interval"])
    expect((await storedRule(view.id)).version).toBe(view.version)
  })

  it("leaves what was posted and the pending days exactly as they were, and only the future follows the new template", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(w.user.id, monthly(w, { startDate: day("2026-03-01"), note: "march rent" }))
    expect(await datesOf(view.id)).toEqual(["2026-03-01", "2026-04-01", "2026-05-01"])
    const [first, second] = await occurrencesOf(view.id)
    await postOccurrence(w.user.id, first.id)
    const posted = await prisma.transaction.findFirstOrThrow({ where: { userId: w.user.id, idempotencyKey: `recurring:${first.id}` } })
    const before = await occurrencesOf(view.id)

    const edited = await editRule(
      w.user.id,
      view.id,
      view.version,
      editOf(w, "2026-06-15", { name: "Rent 2", amount: 250_00n, dayOfMonth: 15, note: "new note" }),
    )

    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: posted.id } })).toEqual(posted)
    expect(await occurrencesOf(view.id)).toEqual(before) // same rows: same dueOns, statuses and links
    expect(edited.nextDueOn).toBe("2026-06-15")
    expect(edited.startDate).toBe("2026-06-15")
    expect(edited.amountPaise).toBe("25000")
    expect(edited.version).toBeGreaterThan(view.version)

    // A pending day reads the rule's current template when it is posted (EC-44), the posted one is what was recorded.
    await postOccurrence(w.user.id, second.id)
    const secondTx = await prisma.transaction.findFirstOrThrow({ where: { userId: w.user.id, idempotencyKey: `recurring:${second.id}` } })
    expect(secondTx.amountPaise).toBe(250_00n)
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: posted.id } })).amountPaise).toBe(100_00n)
  })

  it("keeps a leap-day yearly rule on the 29th when it is re-anchored on 28 February", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(
      w.user.id,
      monthly(w, { frequency: "YEARLY", startDate: day("2024-02-29"), dayOfMonth: 29 }),
    )
    expect(await datesOf(view.id)).toEqual(["2024-02-29", "2025-02-28", "2026-02-28"])
    expect(view.nextDueOn).toBe("2027-02-28")

    const edited = await editRule(
      w.user.id,
      view.id,
      view.version,
      editOf(w, "2026-02-28", { frequency: "YEARLY", dayOfMonth: 29 }),
    )

    const stored = await storedRule(view.id)
    expect(stored.dayOfMonth).toBe(29)
    expect(fromDbDate(stored.startDate)).toBe("2026-02-28")
    expect(edited.nextDueOn).toBe("2027-02-28")
    expect(await occurrencesOf(view.id)).toHaveLength(3) // 28 Feb 2026 already had its entry: no second one
    expect(datesDue(scheduleOfRule(stored), { from: day("2027-02-28"), count: 3, max: 2 })).toEqual(["2027-02-28", "2028-02-29"])
  })

  it("starts a changed schedule at the chosen next due date: every 2 months to every 3", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(w.user.id, monthly(w, { interval: 2, startDate: day("2026-06-10") }))
    expect(view.nextDueOn).toBe("2026-06-10")

    const edited = await editRule(w.user.id, view.id, view.version, editOf(w, "2026-07-20", { interval: 3, dayOfMonth: 20 }))

    expect(edited.nextDueOn).toBe("2026-07-20")
    expect(edited.scheduleText).toBe("Every 3 months on the 20th")
    const stored = await storedRule(view.id)
    expect(datesDue(scheduleOfRule(stored), { from: day("2026-07-20"), count: 0, max: 3 })).toEqual(["2026-07-20", "2026-10-20", "2027-01-20"])
  })

  it("catches up an earlier next due date, within the limit, and refuses one that is too far back", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(w.user.id, monthly(w))
    const edited = await editRule(w.user.id, view.id, view.version, editOf(w, "2026-04-01"))
    expect(await datesOf(view.id)).toEqual(["2026-04-01", "2026-05-01"])
    expect(edited.nextDueOn).toBe("2026-06-01")

    const error = await refusal(
      editRule(w.user.id, view.id, edited.version, editOf(w, "2025-04-14", { frequency: "DAILY" })),
    )
    expect(fieldsOf(error)).toEqual(["nextDue"])
  })
})

// A rule that cannot be edited cannot even be renamed, so two kinds that used to be locked out are held open here.
describe("editing a rule that is paused or has ended", () => {
  it("renames a daily rule paused for more than 100 days: nothing is generated for a paused rule, and resuming recomputes", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(w.user.id, monthly(w, { frequency: "DAILY", startDate: day("2026-05-19") }))
    const paused = await setPaused(w.user.id, view.id, true)
    expect(paused.nextDueOn).toBe("2026-05-20") // stale from here on: nothing moves it while paused

    at("2026-10-01T06:00:00Z") // 134 days on
    const renamed = await editRule(w.user.id, view.id, paused.version, editOf(w, paused.nextDueOn!, { name: "Flat rent", frequency: "DAILY" }))
    expect(renamed.name).toBe("Flat rent")
    expect(renamed.state).toBe("paused")
    expect(await datesOf(view.id)).toEqual(["2026-05-19"]) // not 134 entries, and not any

    // Resuming starts from after today, as ever.
    const resumed = await setPaused(w.user.id, view.id, false)
    expect(resumed.nextDueOn).toBe("2026-10-02")
    expect(await datesOf(view.id)).toEqual(["2026-05-19"])
  })

  it("still refuses more than 100 entries due at once for a rule that is not paused", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(w.user.id, monthly(w, { frequency: "DAILY", startDate: day("2026-05-19") }))
    at("2026-10-01T06:00:00Z")
    // Not paused, with a next due day far behind (as a rule blocked by an archived account can be): the check stands.
    await prisma.recurringRule.update({ where: { id: view.id }, data: { nextDueOn: new Date("2026-05-20T00:00:00Z") } })
    const error = await refusal(editRule(w.user.id, view.id, (await storedRule(view.id)).version, editOf(w, "2026-05-20", { frequency: "DAILY" })))
    expect(fieldsOf(error)).toEqual(["nextDue"])
  })

  it("edits a rule that ended by its end date when the form's date is the end date, and it stays ended", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(
      w.user.id,
      monthly(w, { dayOfMonth: 31, startDate: day("2026-01-31"), endDate: day("2026-04-30") }),
    )
    expect(view.state).toBe("finished")
    expect(await datesOf(view.id)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"])

    // What the form offers for it (see valuesOfRule): the end date, not today, which is after the end.
    const renamed = await editRule(w.user.id, view.id, view.version, editOf(w, "2026-04-30", { name: "Flat rent", dayOfMonth: 31, endDate: day("2026-04-30") }))
    expect(renamed.name).toBe("Flat rent")
    expect(renamed.state).toBe("finished")
    expect(renamed.nextDueOn).toBeNull()
    expect(await datesOf(view.id)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]) // nothing proposed twice

    // Today as the date, which is what it used to offer, is after the end date: refused, which is why it was never usable.
    const error = await refusal(editRule(w.user.id, view.id, renamed.version, editOf(w, "2026-05-19", { dayOfMonth: 31, endDate: day("2026-04-30") })))
    expect(fieldsOf(error)).toEqual(["endDate"])
  })
})

describe("pause and resume", () => {
  it("a paused rule generates nothing, and shows as paused", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(w.user.id, monthly(w, { frequency: "WEEKLY", startDate: day("2026-05-19") }))
    expect(await datesOf(view.id)).toEqual(["2026-05-19"])

    const paused = await setPaused(w.user.id, view.id, true)
    expect(paused.state).toBe("paused")
    expect((await setPaused(w.user.id, view.id, true)).state).toBe("paused") // again: the same answer

    at("2026-06-30T06:00:00Z")
    expect(await generateDue(w.user.id)).toEqual({ created: 0, posted: 0 })
    expect(await datesOf(view.id)).toEqual(["2026-05-19"])
  })

  it("resuming after a long pause backfills nothing: the first new date is after today", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(w.user.id, monthly(w, { frequency: "WEEKLY", startDate: day("2026-05-19") }))
    await setPaused(w.user.id, view.id, true)

    at("2026-06-30T06:00:00Z") // a Tuesday, six weeks on
    const resumed = await setPaused(w.user.id, view.id, false)
    expect(resumed.state).toBe("active")
    expect(resumed.nextDueOn).toBe("2026-07-07")
    expect(await datesOf(view.id)).toEqual(["2026-05-19"]) // nothing for the weeks in between
    expect(await generateDue(w.user.id)).toEqual({ created: 0, posted: 0 })

    at("2026-07-07T06:00:00Z")
    expect(await generateDue(w.user.id)).toEqual({ created: 1, posted: 0 })
    expect(await datesOf(view.id)).toEqual(["2026-05-19", "2026-07-07"])
  })

  it("resuming a rule that is not paused changes nothing", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(w.user.id, monthly(w))
    const same = await setPaused(w.user.id, view.id, false)
    expect(same.version).toBe(view.version)
    expect(same.nextDueOn).toBe("2026-06-01")
  })
})

describe("deleteRule", () => {
  it("removes pending entries, keeps posted and skipped ones and the transactions, and the rule is gone from the list", async () => {
    at(TODAY)
    const w = await setup()
    const view = await createRule(w.user.id, monthly(w, { startDate: day("2026-03-01") }))
    const [march, april] = await occurrencesOf(view.id)
    await postOccurrence(w.user.id, march.id)
    await dismissOccurrence(w.user.id, april.id)

    await deleteRule(w.user.id, view.id)

    const left = await occurrencesOf(view.id)
    expect(left.map((o) => o.status)).toEqual(["POSTED", "DISMISSED"])
    expect(await prisma.transaction.count({ where: { userId: w.user.id, idempotencyKey: `recurring:${march.id}`, deletedAt: null } })).toBe(1)
    expect((await findRules(w.user.id)).map((r) => r.id)).not.toContain(view.id)
    expect((await storedRule(view.id)).deletedAt).not.toBeNull()
    await expect(deleteRule(w.user.id, view.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe("the rule view", () => {
  it("is blocked while an end is archived, and finished once the schedule has run out", async () => {
    at(TODAY)
    const w = await setup()
    const blocked = await createRule(w.user.id, monthly(w))
    const shop = await registry.makeNode(w.user.id, "EXPENSE", "Shop")
    const finished = await createRule(w.user.id, monthly(w, { toNodeId: shop.id, startDate: day("2026-05-01"), occurrenceLimit: 1 }))
    expect(finished.nextDueOn).toBeNull()
    expect(finished.state).toBe("finished")

    await prisma.ledgerNode.update({ where: { id: w.food.id }, data: { archivedAt: new Date() } })
    expect((await setPaused(w.user.id, blocked.id, false)).state).toBe("blocked")
  })
})
