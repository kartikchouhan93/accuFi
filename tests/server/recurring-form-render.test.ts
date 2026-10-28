import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { calendarDate, type CalendarDate } from "@/domain/calendar-date"
import type { RuleView } from "@/lib/recurring-view"
import type { ListEntry, PickerNode } from "@/lib/transaction-list-view"
import type { TransactionView } from "@/lib/transaction-view"
import { createRegistry } from "./repositories/fixtures"

// What the rule form, its two pages and the "Make recurring" link say, as markup, from literal props shaped exactly as the
// server sends them (paise as text, days as "YYYY-MM-DD"). Rendering to markup has no app router, so the router is stubbed;
// the Server Actions are never called from a render. The pages are called as functions with the session replaced.

const { requireUserId, auth, UnauthenticatedError } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), auth: vi.fn(), UnauthenticatedError }
})
vi.mock("@/server/auth", () => ({ requireUserId, auth, UnauthenticatedError, signOut: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const { RuleForm } = await import("@/app/recurring/rule-form")
const { blankValues, valuesOfDraft, valuesOfRule } = await import("@/app/recurring/rule-fields")
const { default: NewRulePage } = await import("@/app/recurring/new/page")
const { default: EditRulePage } = await import("@/app/recurring/[id]/edit/page")
const { EntryRow } = await import("@/app/transactions/transaction-row")
const { templateFromTransaction } = await import("@/server/services/recurring-service")

const day = calendarDate
const TODAY = day("2026-01-01")

const node = (over: Partial<PickerNode> & Pick<PickerNode, "id" | "name" | "kind">): PickerNode => ({
  archived: false,
  systemRole: null,
  valuationMode: null,
  unitLabel: null,
  ...over,
})
const NODES: PickerNode[] = [
  node({ id: "salary", name: "Salary", kind: "INCOME_SOURCE" }),
  node({ id: "bank", name: "HDFC Savings", kind: "ASSET" }),
  node({ id: "wallet", name: "Wallet", kind: "ASSET" }),
  node({ id: "food", name: "Food", kind: "EXPENSE" }),
  node({ id: "mf", name: "Index Fund", kind: "INVESTMENT", valuationMode: "CONTRIBUTION_ONLY" }),
  node({ id: "gold", name: "Gold", kind: "INVESTMENT", valuationMode: "QUANTITY", unitLabel: "g" }),
  node({ id: "old", name: "Old Account", kind: "ASSET", archived: true }),
]

type Values = ReturnType<typeof blankValues>
const form = (values: Partial<Values> = {}, over: { today?: CalendarDate; editing?: { id: string; version: number; occurrences: number; paused?: boolean } | null; nodes?: PickerNode[] } = {}) =>
  renderToStaticMarkup(
    createElement(RuleForm, {
      nodes: over.nodes ?? NODES,
      today: over.today ?? TODAY,
      initial: { ...blankValues(over.today ?? TODAY), from: "bank", to: "food", amount: "100.00", ...values },
      editing: over.editing ?? null,
    }),
  )

const accessibleText = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'")
const text = (html: string) => accessibleText(html).replace(/\s+/g, " ")
/** The names of the options of the select with this id suffix, in order. */
function optionsOf(html: string, suffix: string): string[] {
  const select = html.match(new RegExp(`<select[^>]*id="[^"]*-${suffix}"[^>]*>([\\s\\S]*?)</select>`))
  expect(select, `a select ending in -${suffix}`).not.toBeNull()
  return [...select![1].matchAll(/<option[^>]*>([\s\S]*?)<\/option>/g)].map((m) => accessibleText(m[1]))
}
const hasControl = (html: string, suffix: string) => new RegExp(`id="[^"]*-${suffix}"`).test(html)
const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ name: accessibleText(m[2]).trim(), attrs: m[1] }))
const links = (html: string): [string, string][] =>
  [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1], accessibleText(m[2]).trim()])

describe("which day control the form shows", () => {
  it("shows the day of the month, and not the day of the week, for a monthly rule", () => {
    const html = form({ frequency: "MONTHLY" })
    expect(text(html)).toContain("Day of the month")
    expect(text(html)).not.toContain("Day of the week")
    expect(hasControl(html, "day-of-month")).toBe(true)
    expect(hasControl(html, "day-of-week")).toBe(false)
  })

  it("shows the day of the week, and not the day of the month, for a weekly rule", () => {
    const html = form({ frequency: "WEEKLY" })
    expect(text(html)).toContain("Day of the week")
    expect(text(html)).not.toContain("Day of the month")
    expect(optionsOf(html, "day-of-week")).toEqual(["Same as the start date", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])
  })

  it("shows neither for a daily rule, and the day of the month for quarterly and yearly", () => {
    const daily = form({ frequency: "DAILY" })
    expect(text(daily)).not.toMatch(/Day of the (month|week)/)
    expect(text(form({ frequency: "QUARTERLY" }))).toContain("Day of the month")
    expect(text(form({ frequency: "YEARLY" }))).toContain("Day of the month")
  })

  it("says what 31 means beside the day of the month", () => {
    expect(text(form({ frequency: "MONTHLY" }))).toContain("31, or the last day if the month is shorter")
    expect(text(form({ frequency: "WEEKLY" }))).not.toContain("the last day if the month is shorter")
  })

  it("offers every day of the month and a default of the start date's own", () => {
    const options = optionsOf(form({ frequency: "MONTHLY" }), "day-of-month")
    expect(options[0]).toBe("Same as the start date")
    expect(options.slice(1)).toEqual(Array.from({ length: 31 }, (_, i) => String(i + 1)))
  })
})

describe("the date control", () => {
  it("is Starts on when creating and Next due on when editing", () => {
    expect(text(form())).toContain("Starts on")
    expect(text(form())).not.toContain("Next due on")
    const html = form({}, { editing: { id: "r1", version: 2, occurrences: 0 } })
    expect(text(html)).toContain("Next due on")
    expect(text(html)).not.toContain("Starts on")
    expect(text(html)).toContain("Save changes")
    expect(text(form())).toContain("Create rule")
  })
})

describe("the live schedule preview", () => {
  it("shows the schedule in words and the next three dates, clamping the short month from the anchor", () => {
    const html = form({ anchor: "2026-01-31", frequency: "MONTHLY" })
    const preview = html.slice(html.indexOf('aria-label="Schedule preview"'))
    expect(text(preview)).toContain("Monthly on the 31st, or the last day")
    expect(text(preview)).toContain("31 Jan 2026")
    expect(text(preview)).toContain("28 Feb 2026")
    expect(text(preview)).toContain("31 Mar 2026")
    expect(text(preview)).not.toContain("30 Apr 2026") // three, not four
    expect(preview).toContain("figures")
  })

  it("follows the weekday and the interval", () => {
    const html = form({ anchor: "2026-01-05", frequency: "WEEKLY", interval: "2", dayOfWeek: "1" })
    const preview = text(html.slice(html.indexOf('aria-label="Schedule preview"')))
    expect(preview).toContain("Every 2 weeks on Monday")
    expect(preview).toContain("5 Jan 2026")
    expect(preview).toContain("19 Jan 2026")
    expect(preview).toContain("2 Feb 2026")
  })

  it("says nothing is waiting when the start is today or later", () => {
    expect(text(form({ anchor: "2026-01-01" }))).toContain("1 entry will appear in your inbox now.")
    expect(text(form({ anchor: "2026-02-01" }))).not.toContain("inbox now")
  })

  it("says how many entries will appear at once when the start is in the past", () => {
    const html = form({ anchor: "2026-08-01" }, { today: day("2026-10-28") })
    expect(text(html)).toContain("3 entries will appear in your inbox now.")
  })

  it("says it is too many to create at once beyond what one save may make, not that they will appear", () => {
    const html = form({ anchor: "2020-01-01", frequency: "DAILY" }, { today: day("2026-10-28") })
    expect(text(html)).toContain("That is too many to create at once. Choose a later start date.")
    expect(text(html)).not.toMatch(/more than 100|will appear in your inbox/i)
  })

  it("says a paused rule makes no entries, whatever the date, and does not claim any will appear or be too many", () => {
    const html = form(
      { anchor: "2026-05-20", frequency: "DAILY" },
      { today: day("2026-10-28"), editing: { id: "r1", version: 2, occurrences: 1, paused: true } },
    )
    expect(text(html)).toContain("It is paused, so it makes no entries until you resume it.")
    expect(text(html)).not.toMatch(/too many|inbox now/i)
  })

  it("says the entries are posted when the rule posts itself", () => {
    const html = form({ anchor: "2026-08-01", autoPost: true }, { today: day("2026-10-28") })
    expect(text(html)).toContain("3 entries will be posted now.")
    expect(text(html)).not.toContain("inbox now")
  })

  it("shows only what an occurrence limit has left when editing", () => {
    const html = form({ anchor: "2026-02-01", occurrenceLimit: "3" }, { editing: { id: "r1", version: 0, occurrences: 2 } })
    const preview = text(html.slice(html.indexOf('aria-label="Schedule preview"')))
    expect(preview).toContain("1 Feb 2026")
    expect(preview).not.toContain("1 Mar 2026")
    expect(preview).toContain("Then it ends.")
  })

  it("shows no dates, and says why, when the limit is already spent", () => {
    const html = form({ occurrenceLimit: "2" }, { editing: { id: "r1", version: 0, occurrences: 2 } })
    expect(text(html)).toContain("no dates left")
  })

  it("asks for the schedule instead of guessing when a field is not sound", () => {
    const html = form({ interval: "0" })
    const preview = text(html.slice(html.indexOf('aria-label="Schedule preview"')))
    expect(preview).toContain("Fill in the schedule")
    expect(preview).not.toContain("inbox now")
  })
})

describe("Post automatically", () => {
  it("is a switch for an ordinary destination", () => {
    const html = form({ to: "food" })
    expect(html).toMatch(/<input[^>]*type="checkbox"/)
    expect(text(html)).toContain("Post automatically")
    expect(text(html)).not.toContain("cannot be posted automatically")
  })

  it("is on offer before a destination is chosen", () => {
    expect(form({ to: "" })).toMatch(/<input[^>]*type="checkbox"/)
  })

  it("is hidden for an investment valued by quantity, with the reason", () => {
    const html = form({ to: "gold", autoPost: true })
    expect(html).not.toMatch(/<input[^>]*type="checkbox"/)
    expect(text(html)).toContain("needs a quantity for each purchase, so it cannot be posted automatically")
  })

  it("is still offered for an investment valued some other way", () => {
    expect(form({ to: "mf" })).toMatch(/<input[^>]*type="checkbox"/)
  })
})

describe("the pickers", () => {
  it("offers a destination only if the flow from the source is allowed, and never the source itself", () => {
    const options = optionsOf(form({ from: "bank", to: "" }), "to")
    expect(options).toEqual(expect.arrayContaining(["Choose a destination", "Wallet", "Food", "Index Fund"]))
    expect(options).not.toContain("HDFC Savings")
    expect(options).not.toContain("Salary") // money does not flow from an account to an income source
  })

  it("asks for a source first, with no destination to choose", () => {
    const html = form({ from: "", to: "" })
    expect(optionsOf(html, "to")).toEqual(["Choose a source first"])
    expect(html).toMatch(/<select[^>]*id="[^"]*-to"[^>]*disabled/)
  })

  it("does not offer an archived account for a new rule, but keeps one the form opened with", () => {
    expect(optionsOf(form({ from: "bank", to: "" }), "to")).not.toContain("Old Account (archived)")
    expect(optionsOf(form({ from: "bank", to: "old" }), "to")).toContain("Old Account (archived)")
  })
})

describe("the controls", () => {
  it("keeps every number as text: the amount, the interval and the limit are never a number input", () => {
    const html = form()
    expect(html).not.toMatch(/type="number"/)
    expect(html).toMatch(/<input[^>]*type="text"[^>]*inputMode="decimal"/)
    expect(html).toMatch(/type="date"/)
  })

  it("carries the name, the optional end and limit, the note and the tags", () => {
    const html = form({ name: "Rent", endDate: "2027-01-01", occurrenceLimit: "12", note: "Flat 4B", tags: "home, rent" })
    for (const value of ["Rent", "2027-01-01", "12", "Flat 4B", "home, rent"]) expect(html).toContain(`value="${value}"`)
    expect(text(html)).toContain("Ends on")
    expect(text(html)).toContain("Stops after")
  })

  it("has a way back that is a link, and no Cancel button", () => {
    const html = form()
    expect(links(html)).toContainEqual(["/recurring", "Cancel"])
    expect(buttons(html).map((b) => b.name)).toEqual(["Create rule"])
  })
})

// -- A form opened from a transaction, and the pages ----------------------------------------------------------------------

const registry = createRegistry()
afterAll(registry.cleanup)
beforeEach(() => {
  requireUserId.mockReset()
  auth.mockReset()
})

function elementsIn(node: ReactNode, found: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return
    found.push(child)
    elementsIn(child.props.children as ReactNode, found)
  })
  return found
}

async function signedInWorld() {
  const user = await registry.makeUser()
  const bank = await registry.makeNode(user.id, "ASSET", "HDFC Savings")
  const food = await registry.makeNode(user.id, "EXPENSE", "Groceries")
  const tx = await registry.makeTransaction(user.id, bank.id, food.id, { amountPaise: 123_450n, occurredAt: "2026-03-31", note: "Weekly shop", tags: ["home"] })
  requireUserId.mockResolvedValue(user.id)
  auth.mockResolvedValue({ user: { id: user.id, email: user.email }, expires: "2099-01-01" })
  return { user, bank, food, tx }
}

describe("a form prefilled from a transaction", () => {
  it("carries the transaction's nodes, amount, note and tags, monthly from the next month's same day (clamped)", async () => {
    const w = await signedInWorld()
    const { draft, nodes, today } = await templateFromTransaction(w.user.id, w.tx.id)
    const html = renderToStaticMarkup(createElement(RuleForm, { nodes, today, initial: valuesOfDraft(draft), editing: null }))
    expect(html).toContain(`<option value="${w.bank.id}" selected`)
    expect(html).toContain(`<option value="${w.food.id}" selected`)
    expect(html).toContain('value="1234.50"')
    expect(html).toContain('value="Weekly shop"')
    expect(html).toContain('value="home"')
    expect(html).toContain('value="2026-04-30"') // 31 March, a month on: April has 30 days
    // The transaction's own day (31) is the rule's day of the month: April's 30th is only the first clamp of it.
    expect(html).toContain('<option value="31" selected')
    expect(text(html)).toContain("Monthly on the 31st, or the last day")
    expect(text(html)).toContain("30 Apr 202631 May 202630 Jun 2026")
    // The name is the user's to give.
    expect(html).toMatch(/<input[^>]*id="[^"]*-name"[^>]*value=""/)
  })
})

describe("the new-rule page", () => {
  const page = (from?: string) => NewRulePage({ searchParams: Promise.resolve(from === undefined ? {} : { from }) })
  const formOf = (tree: unknown) => elementsIn(tree as ReactNode).find((element) => element.type === RuleForm)

  it("opens a blank form, monthly from today", async () => {
    await signedInWorld()
    const found = formOf(await page())
    expect(found).toBeDefined()
    const props = found!.props as unknown as { initial: Values; editing: unknown; nodes: PickerNode[] }
    expect(props.editing).toBeNull()
    expect(props.initial).toMatchObject({ from: "", to: "", frequency: "MONTHLY", interval: "1" })
    expect(props.nodes.map((n) => n.name).sort()).toEqual(["Groceries", "HDFC Savings"])
  })

  it("fills the form from `?from=<transactionId>`", async () => {
    const w = await signedInWorld()
    const props = formOf(await page(w.tx.id))!.props as unknown as { initial: Values }
    expect(props.initial).toMatchObject({ from: w.bank.id, to: w.food.id, amount: "1234.50", note: "Weekly shop", tags: "home", anchor: "2026-04-30" })
  })

  it("is a plain 404 for an id that names nothing, an empty one, or another user's transaction", async () => {
    const w = await signedInWorld()
    const stranger = await registry.makeUser()
    const sBank = await registry.makeNode(stranger.id, "ASSET", "Bank")
    const sFood = await registry.makeNode(stranger.id, "EXPENSE", "Food")
    const theirs = await registry.makeTransaction(stranger.id, sBank.id, sFood.id)
    const notFound = { digest: expect.stringContaining("404") }
    await expect(page("no-such-transaction")).rejects.toMatchObject(notFound)
    await expect(page("")).rejects.toMatchObject(notFound)
    await expect(page(theirs.id)).rejects.toMatchObject(notFound)
    expect(w.tx.id).not.toBe(theirs.id)
  })

  it("is a plain 404 for a leg of a split, and for an entry touching a system node", async () => {
    const w = await signedInWorld()
    const { prisma } = await import("@/server/db")
    const group = await prisma.transactionGroup.create({ data: { userId: w.user.id, kind: "MANUAL_SPLIT" } })
    const leg = await prisma.transaction.create({
      data: { userId: w.user.id, fromNodeId: w.bank.id, toNodeId: w.food.id, amountPaise: 100n, occurredAt: w.tx.occurredAt, groupId: group.id },
    })
    const opening = await registry.makeNode(w.user.id, "INCOME_SOURCE", "Opening Balance", { systemRole: "OPENING_BALANCE" })
    const fromOpening = await registry.makeTransaction(w.user.id, opening.id, w.bank.id)
    const notFound = { digest: expect.stringContaining("404") }
    await expect(page(leg.id)).rejects.toMatchObject(notFound)
    await expect(page(fromOpening.id)).rejects.toMatchObject(notFound)
  })
})

describe("the edit page", () => {
  const page = (id: string) => EditRulePage({ params: Promise.resolve({ id }) })
  const formOf = (tree: unknown) => elementsIn(tree as ReactNode).find((element) => element.type === RuleForm)

  it("opens the rule as stored, with the version it must send back, keyed by it", async () => {
    const w = await signedInWorld()
    const rule = await registry.makeRule(w.user.id, w.bank.id, w.food.id, { name: "Rent", amountPaise: 1_500_000n, startDate: "2026-04-01", nextDueOn: "2026-11-01", version: 4 })
    await registry.makeOccurrence(w.user.id, rule.id, "2026-10-01")
    const found = formOf(await page(rule.id))
    expect(found).toBeDefined()
    expect(found!.key).toBe(`${rule.id}:4`)
    const props = found!.props as unknown as { initial: Values; editing: { id: string; version: number; occurrences: number; paused: boolean } }
    expect(props.editing).toEqual({ id: rule.id, version: 4, occurrences: 1, paused: false })
    expect(props.initial).toMatchObject({ name: "Rent", from: w.bank.id, to: w.food.id, amount: "15000.00", anchor: "2026-11-01", frequency: "MONTHLY", dayOfMonth: "1" })
  })

  it("tells the form the rule is paused, so its preview does not promise entries", async () => {
    const w = await signedInWorld()
    const rule = await registry.makeRule(w.user.id, w.bank.id, w.food.id, { pausedAt: new Date(), nextDueOn: "2026-05-20", frequency: "DAILY" })
    const found = formOf(await page(rule.id))
    expect((found!.props as unknown as { editing: { paused: boolean } }).editing.paused).toBe(true)
  })

  it("is a plain 404 for a rule that does not exist, is another user's, or is deleted", async () => {
    const w = await signedInWorld()
    const stranger = await registry.makeUser()
    const sBank = await registry.makeNode(stranger.id, "ASSET", "Bank")
    const sFood = await registry.makeNode(stranger.id, "EXPENSE", "Food")
    const theirs = await registry.makeRule(stranger.id, sBank.id, sFood.id)
    const gone = await registry.makeRule(w.user.id, w.bank.id, w.food.id, { deletedAt: new Date() })
    const notFound = { digest: expect.stringContaining("404") }
    await expect(page("no-such-rule")).rejects.toMatchObject(notFound)
    await expect(page(theirs.id)).rejects.toMatchObject(notFound)
    await expect(page(gone.id)).rejects.toMatchObject(notFound)
  })

  it("renders a form that edits, from the values of the rule view", () => {
    const view: RuleView = {
      id: "r1", name: "Gym", fromNodeId: "bank", toNodeId: "food", fromName: "HDFC Savings", toName: "Food", amountPaise: "99900",
      note: null, tags: [], frequency: "WEEKLY", interval: 1, dayOfMonth: null, dayOfWeek: 3, startDate: "2026-01-07", endDate: null,
      occurrenceLimit: null, autoPost: false, nextDueOn: "2026-02-04", state: "active", scheduleText: "Weekly on Wednesday", version: 1,
    }
    const html = renderToStaticMarkup(
      createElement(RuleForm, { nodes: NODES, today: TODAY, initial: valuesOfRule(view, TODAY), editing: { id: "r1", version: 1, occurrences: 4 } }),
    )
    expect(html).toContain('value="Gym"')
    expect(html).toContain('value="999.00"')
    expect(html).toContain('<option value="3" selected')
    expect(text(html)).toContain("4 Feb 2026")
    expect(text(html)).toContain("Weekly on Wednesday")
  })
})

// -- "Make recurring" on a transaction row ---------------------------------------------------------------------------------

describe("Make recurring on a row", () => {
  const view = (over: Partial<TransactionView> = {}): TransactionView => ({
    id: "t1", fromNodeId: "bank", toNodeId: "food", amountPaise: "50000", occurredAt: day("2026-03-31"), note: null, tags: [],
    groupId: null, deleted: false, version: 0, warnings: [], ...over,
  })
  const nodes = new Map(NODES.map((n) => [n.id, n]))
  nodes.set("opening", node({ id: "opening", name: "Opening Balance", kind: "INCOME_SOURCE", systemRole: "OPENING_BALANCE" }))
  const context = { nodes, today: TODAY, announce: vi.fn(), onEdit: vi.fn() }
  const row = (entry: ListEntry) => renderToStaticMarkup(createElement("ul", null, createElement(EntryRow, { entry, context, startOpen: true })))
  const single = (over: Partial<TransactionView> = {}, sale?: true): ListEntry => ({ kind: "single", transaction: view(over), ...(sale ? { sale } : {}) })
  const group = (): ListEntry => ({
    kind: "group", groupId: "g1", occurredAt: day("2026-03-31"), fromNodeId: "bank", totalPaise: "100000", deleted: false,
    legs: [view({ id: "l1", groupId: "g1", toNodeId: "food" }), view({ id: "l2", groupId: "g1", toNodeId: "wallet" })],
  })

  it("links a single entry to the new-rule form, prefilled from it", () => {
    expect(links(row(single()))).toContainEqual(["/recurring/new?from=t1", "Make recurring"])
  })

  it("is not offered on a split, whose legs are not one movement", () => {
    expect(row(group())).not.toContain("Make recurring")
    expect(row(single({ groupId: "g1" }))).not.toContain("Make recurring")
  })

  it("is not offered on an entry touching a system node", () => {
    expect(row(single({ fromNodeId: "opening" }))).not.toContain("Make recurring")
  })

  it("is not offered on a deleted entry or a sale", () => {
    expect(row(single({ deleted: true }))).not.toContain("Make recurring")
    expect(row(single({}, true))).not.toContain("Make recurring")
  })

  it("is not in a closed row: the details open first, as before", () => {
    const closed = renderToStaticMarkup(createElement("ul", null, createElement(EntryRow, { entry: single(), context })))
    expect(closed).not.toContain("Make recurring")
    expect(buttons(row(single())).map((b) => b.name)).toEqual(expect.arrayContaining(["Edit", "Delete"]))
  })
})
