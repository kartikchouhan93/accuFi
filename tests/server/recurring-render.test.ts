import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { OccurrenceView, RuleView } from "@/lib/recurring-view"
import { createRegistry } from "./repositories/fixtures"

// What the Recurring screen, its nav item and the dashboard notice say, as markup, from literal views shaped exactly as
// the server sends them (paise as text, days as "YYYY-MM-DD"). Rendering to markup has no app router, so the router is
// stubbed; the server actions are never called from a render. Then the two server components that read the pending
// count (the shell and the dashboard), with the session replaced.

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

const { Inbox } = await import("@/app/recurring/inbox")
const { InboxCard } = await import("@/app/recurring/inbox-card")
const { RulesList } = await import("@/app/recurring/rules-list")
const { RecentList } = await import("@/app/recurring/recent-list")
const { PendingNotice } = await import("@/app/pending-notice")
const { AppNav } = await import("@/app/app-nav")
const { AppShell } = await import("@/app/app-shell")
const { default: DashboardPage } = await import("@/app/page")

const announce = vi.fn()

const occurrence = (over: Partial<OccurrenceView> = {}): OccurrenceView => ({
  id: "o1",
  ruleId: "r1",
  ruleName: "Rent",
  dueOn: "2026-11-01",
  status: "PENDING",
  fromNodeId: "n1",
  toNodeId: "n2",
  fromName: "HDFC Savings",
  toName: "Housing",
  amountPaise: "1500000",
  note: null,
  tags: [],
  postFailure: null,
  needsQuantity: false,
  unitLabel: null,
  nodeArchived: false,
  transactionId: null,
  ...over,
})

const rule = (over: Partial<RuleView> = {}): RuleView => ({
  id: "r1",
  name: "Rent",
  fromNodeId: "n1",
  toNodeId: "n2",
  fromName: "HDFC Savings",
  toName: "Housing",
  amountPaise: "1500000",
  note: null,
  tags: [],
  frequency: "MONTHLY",
  interval: 1,
  dayOfMonth: 1,
  dayOfWeek: null,
  startDate: "2026-04-01",
  endDate: null,
  occurrenceLimit: null,
  autoPost: false,
  nextDueOn: "2026-11-01",
  state: "active",
  scheduleText: "Monthly on the 1st",
  version: 0,
  ...over,
})

/** All the text, the screen-reader-only parts included: what a link or button is announced as. */
const accessibleText = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'")
/** What is on screen: without the text that only a screen reader reads. */
const visibleText = (html: string) => accessibleText(html.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, ""))

interface Control {
  name: string
  attrs: string
  disabled: boolean
}
const buttons = (html: string): Control[] =>
  [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    name: accessibleText(m[2]).trim(),
    attrs: m[1],
    disabled: /\sdisabled(=|\s|$)/.test(m[1]),
  }))
const buttonNamed = (html: string, name: string | RegExp) =>
  buttons(html).find((b) => (typeof name === "string" ? b.name === name : name.test(b.name)))
const links = (html: string): [string, string][] =>
  [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1], accessibleText(m[2])])

const card = (over: Partial<OccurrenceView> = {}) => renderToStaticMarkup(createElement(InboxCard, { occurrence: occurrence(over), index: 0, announce }))

describe("an inbox card", () => {
  it("shows the rule name, due date, both ends and the amount as the ledger prints it", () => {
    const html = card()
    const text = visibleText(html)
    expect(text).toContain("Rent")
    expect(text).toContain("1 Nov 2026")
    expect(text).toContain("HDFC Savings")
    expect(text).toContain("Housing")
    expect(text).toContain("₹15,000.00")
    expect(html).toContain("figures")
    // Said to a screen reader as a movement, not two unrelated names.
    expect(accessibleText(html)).toMatch(/HDFC Savings\s*to\s*Housing/)
  })

  it("shows why an automatic post did not happen", () => {
    const html = card({ postFailure: "HDFC Savings would go below zero" })
    expect(visibleText(html)).toContain("HDFC Savings would go below zero")
    expect(visibleText(card())).not.toMatch(/did not|could not|below zero/i)
  })

  it("posts with one tap as proposed, edits and posts, or skips", () => {
    const html = card()
    expect(buttonNamed(html, "Post")).toMatchObject({ disabled: false })
    expect(buttonNamed(html, "Post")?.attrs).not.toContain("aria-expanded")
    expect(buttonNamed(html, "Edit and post")).toMatchObject({ disabled: false })
    expect(buttonNamed(html, "Skip")).toMatchObject({ disabled: false })
  })

  it("has no one-tap Post when the entry needs a quantity: Post opens the form, and says why", () => {
    const html = card({ needsQuantity: true, unitLabel: "g", toName: "Gold" })
    const post = buttonNamed(html, "Post")
    expect(post).toBeDefined()
    // A disclosure of the form, not a send: it says it is collapsed.
    expect(post?.attrs).toContain('aria-expanded="false"')
    expect(visibleText(html)).toMatch(/quantity/i)
    expect(visibleText(html)).toContain("g")
    expect(buttonNamed(html, "Skip")).toMatchObject({ disabled: false })
  })

  it("disables Post for an archived account and says why, leaving Skip enabled", () => {
    const html = card({ nodeArchived: true })
    expect(buttonNamed(html, "Post")).toMatchObject({ disabled: true })
    expect(buttonNamed(html, "Edit and post")).toMatchObject({ disabled: true })
    expect(buttonNamed(html, "Skip")).toMatchObject({ disabled: false })
    expect(visibleText(html)).toMatch(/archived/i)
    // The reason is tied to the button, so it is read with it.
    expect(buttonNamed(html, "Post")?.attrs).toContain("aria-describedby")
  })

  it("prints a very large amount to the paisa: paise text never becomes a JS number", () => {
    const html = card({ amountPaise: "123456789012345678" })
    expect(visibleText(html)).toContain("₹1,23,45,67,89,01,23,456.78")
    expect(html).not.toContain("e+")
    expect(html).not.toContain("NaN")
  })

  it("shows the note and the tags", () => {
    const html = card({ note: "Flat 4B", tags: ["home"] })
    expect(visibleText(html)).toContain("Flat 4B")
    expect(visibleText(html)).toContain("home")
  })
})

describe("the inbox", () => {
  const inbox = (views: OccurrenceView[], hasRules = true) => renderToStaticMarkup(createElement(Inbox, { inbox: views, hasRules, announce }))

  it("lists every entry in the order given, one card each", () => {
    const html = inbox([occurrence({ id: "a", ruleName: "Rent" }), occurrence({ id: "b", ruleName: "Gym", dueOn: "2026-11-05" })])
    expect(html.indexOf("Rent")).toBeGreaterThan(-1)
    expect(html.indexOf("Rent")).toBeLessThan(html.indexOf("Gym"))
    expect(visibleText(html)).toContain("2 waiting")
  })

  it("says what a rule is for and links to New rule when there is nothing and no rule", () => {
    const html = inbox([], false)
    expect(visibleText(html)).toMatch(/repeats/i)
    expect(visibleText(html)).toMatch(/rent|SIP|subscription/i)
    expect(links(html)).toContainEqual(["/recurring/new", expect.stringContaining("New rule")])
  })

  it("says nothing is waiting when rules exist but no entry is due", () => {
    const html = inbox([], true)
    expect(visibleText(html)).toMatch(/nothing is waiting/i)
  })
})

describe("the rules list", () => {
  const list = (rules: RuleView[]) => renderToStaticMarkup(createElement(RulesList, { rules, announce }))

  it("shows the schedule in words, the next due day, both ends and the amount", () => {
    const text = visibleText(list([rule()]))
    expect(text).toContain("Monthly on the 1st")
    expect(text).toContain("1 Nov 2026")
    expect(text).toContain("HDFC Savings")
    expect(text).toContain("₹15,000.00")
  })

  it("marks a paused rule with a Paused chip and offers Resume, not Pause", () => {
    const html = list([rule({ state: "paused" })])
    expect(visibleText(html)).toContain("Paused")
    expect(buttonNamed(html, /^Resume/)).toBeDefined()
    expect(buttonNamed(html, /^Pause/)).toBeUndefined()
  })

  it("offers Pause on a running rule, and no state chip", () => {
    const html = list([rule()])
    expect(buttonNamed(html, /^Pause/)).toBeDefined()
    expect(buttonNamed(html, /^Resume/)).toBeUndefined()
    expect(visibleText(html)).not.toMatch(/Paused|Finished|Blocked/)
  })

  it("says a finished rule is finished and has no next day", () => {
    const text = visibleText(list([rule({ state: "finished", nextDueOn: null })]))
    expect(text).toContain("Finished")
    expect(text).not.toContain("Next")
  })

  it("says why a rule blocked by an archived account makes nothing", () => {
    const text = visibleText(list([rule({ state: "blocked" })]))
    expect(text).toContain("Blocked")
    expect(text).toMatch(/archived/i)
  })

  it("links Edit to the edit page and puts Delete behind a confirm", () => {
    const html = list([rule({ id: "abc" })])
    expect(links(html)).toContainEqual(["/recurring/abc/edit", expect.stringContaining("Edit")])
    expect(buttonNamed(html, /^Delete( |$)/)).toBeDefined()
    // Nothing destructive is on offer until Delete is pressed.
    expect(buttonNamed(html, /^Delete rule/)).toBeUndefined()
    expect(visibleText(html)).not.toMatch(/cannot be undone/i)
  })
})

describe("the recently handled list", () => {
  const recent = (views: OccurrenceView[]) => renderToStaticMarkup(createElement(RecentList, { recent: views, announce }))

  it("is a closed disclosure with the count, and shows nothing when there is nothing", () => {
    const html = recent([occurrence({ status: "POSTED" })])
    const toggle = buttonNamed(html, /Recently handled/)
    expect(toggle?.attrs).toContain('aria-expanded="false"')
    expect(visibleText(html)).toContain("1")
    expect(recent([])).toBe("")
  })
})

describe("the nav", () => {
  const nav = (pending: number) =>
    renderToStaticMarkup(createElement(AppNav, { current: "recurring", email: "a@b.test", signOut: async () => {}, pending }))
  /** Every link's accessible name, in order. */
  const names = (html: string) =>
    [...html.matchAll(/<a[^>]*href="[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
      accessibleText(m[1].replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, "")).replace(/\s+/g, " ").trim(),
    )

  it("has a Recurring destination", () => {
    expect(links(nav(0)).some(([href]) => href === "/recurring")).toBe(true)
  })

  it("carries the pending count as a badge and in the accessible name", () => {
    const html = nav(3)
    expect(names(html)).toContain("Recurring, 3 waiting")
    // On screen the badge is the bare number, hidden from the accessible name so it is not read twice.
    expect(html).toMatch(/<span[^>]*aria-hidden="true"[^>]*>3<\/span>/)
  })

  it("has no badge, and the plain name, when nothing is waiting", () => {
    const html = nav(0)
    expect(names(html)).toContain("Recurring")
    expect(accessibleText(html)).not.toContain("waiting")
  })

  it("caps a long count on screen but not in the name", () => {
    const html = nav(250)
    expect(names(html)).toContain("Recurring, 250 waiting")
    expect(html).toContain("99+")
  })
})

describe("the dashboard notice", () => {
  const notice = (count: number) => renderToStaticMarkup(createElement(PendingNotice, { count }))

  it("is one line linking to the inbox", () => {
    const html = notice(3)
    expect(visibleText(html).trim()).toBe("3 entries waiting")
    expect(links(html)).toEqual([["/recurring", "3 entries waiting"]])
  })

  it("says entry, not entries, for one", () => {
    expect(visibleText(notice(1)).trim()).toBe("1 entry waiting")
  })

  it("is nothing for none", () => {
    expect(notice(0)).toBe("")
  })
})

describe("no amount is a number input", () => {
  it("keeps every field of the screen as text, so a figure is never read through a JS number", () => {
    const dir = join(process.cwd(), "src/app/recurring")
    const files = readdirSync(dir).filter((file) => file.endsWith(".tsx"))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(join(dir, file), "utf8")
      expect(source, file).not.toMatch(/type=["']number["']/)
      expect(source, file).not.toMatch(/\bNumber\(\s*[a-z.]*[pP]aise/)
      expect(source, file).not.toMatch(/\bparseFloat\b|\bparseInt\b/)
    }
  })
})

// -- The server components that read the count ---------------------------------------------------------------------

const registry = createRegistry()
afterAll(registry.cleanup)
beforeEach(() => {
  requireUserId.mockReset()
  auth.mockReset()
})

/** Every element in a tree of elements (not expanded: a component is an element with its props). */
function elementsIn(node: ReactNode, found: ReactElement<{ children?: ReactNode }>[] = []): ReactElement<{ children?: ReactNode }>[] {
  Children.forEach(node, (child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return
    found.push(child)
    elementsIn(child.props.children, found)
  })
  return found
}

/** A user with two accounts, `pending` waiting entries (one rule each day), and the session of that user. */
async function userWithPending(pending: number) {
  const user = await registry.makeUser()
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  const live = await registry.makeRule(user.id, bank.id, food.id, { name: "Lunch" })
  for (let day = 1; day <= pending; day++) await registry.makeOccurrence(user.id, live.id, `2026-05-${String(day).padStart(2, "0")}`)
  requireUserId.mockResolvedValue(user.id)
  auth.mockResolvedValue({ user: { id: user.id, email: user.email }, expires: "2099-01-01" })
  return user
}

describe("the app shell", () => {
  const navOf = async (current = "recurring" as const) => {
    const shell = (await AppShell({ children: null, current })) as ReactElement<{ children: ReactNode }>
    const found = elementsIn(shell.props.children).find((element) => element.type === AppNav)
    expect(found).toBeDefined()
    return found!.props as unknown as { pending: number; current: string }
  }

  it("hands the nav the signed-in user's pending count", async () => {
    await userWithPending(3)
    expect((await navOf()).pending).toBe(3)
  })

  it("hands over zero when nothing waits", async () => {
    await userWithPending(0)
    expect((await navOf()).pending).toBe(0)
  })

  it("counts only the signed-in user's entries", async () => {
    await userWithPending(2)
    await userWithPending(0) // the second sign-in is the one in the session now
    expect((await navOf()).pending).toBe(0)
  })

  it("does not fail a page when the session has no user id", async () => {
    auth.mockResolvedValue(null)
    expect((await navOf()).pending).toBe(0)
  })
})

describe("the dashboard page", () => {
  const noticeIn = async () => {
    const page = (await DashboardPage()) as ReactElement<{ children: ReactNode }>
    return elementsIn(page).find((element) => element.type === PendingNotice)
  }

  it("shows the notice with the count when entries wait", async () => {
    await userWithPending(2)
    const found = await noticeIn()
    expect(found).toBeDefined()
    expect((found!.props as unknown as { count: number }).count).toBe(2)
  })

  it("renders no notice when nothing waits", async () => {
    await userWithPending(0)
    expect(await noticeIn()).toBeUndefined()
  })
})
