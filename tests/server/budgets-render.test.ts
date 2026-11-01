import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { spanLabel, type BudgetCard, type BudgetHistoryRow, type BudgetsScreen, type UpcomingBudget } from "@/lib/budget-view"

// What the Budgets screen, its nav item and its month parameter say, as markup, from literal views shaped exactly as the
// server sends them (paise as text, months as "YYYY-MM-01"). Rendering to markup has no app router, so the router is
// stubbed; the server actions are never called from a render. Nothing here reads the clock: "today" is whatever the view says.

const { requireUserId, auth, UnauthenticatedError, loadBudgetsScreen, redirect } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), auth: vi.fn(), UnauthenticatedError, loadBudgetsScreen: vi.fn(), redirect: vi.fn() }
})
vi.mock("@/server/auth", () => ({ requireUserId, auth, UnauthenticatedError, signOut: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/server/services/budget-report", () => ({ loadBudgetsScreen }))
vi.mock("@/app/app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }))
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  redirect,
}))

const { BudgetCardItem } = await import("@/app/budgets/budget-card")
const { HistoryTable } = await import("@/app/budgets/history-table")
const { MonthPicker } = await import("@/app/budgets/month-picker")
const { BudgetsWorkspace } = await import("@/app/budgets/budgets-workspace")
const { barWidth, cardDeleteText, percentText, upcomingDeleteText } = await import("@/app/budgets/budget-text")
const { monthFromParam } = await import("@/app/budgets/month-param")
const { default: BudgetsPage } = await import("@/app/budgets/page")
const { AppNav } = await import("@/app/app-nav")

const announce = vi.fn()

const historyRow = (over: Partial<BudgetHistoryRow> = {}): BudgetHistoryRow => ({
  month: "2026-11-01",
  usedPaise: "846000",
  availablePaise: "1000000",
  status: "ON_TRACK",
  drillHref: "/transactions?node=n1&flow=spending&from=2026-11-01&to=2026-11-15",
  ...over,
})

const card = (over: Partial<BudgetCard> = {}): BudgetCard => ({
  budgetId: "b1",
  nodeId: "n1",
  name: "Groceries",
  archived: false,
  countedNames: [],
  amountPaise: "1000000",
  carryPaise: "0",
  availablePaise: "1000000",
  usedPaise: "846000",
  remainingPaise: "154000",
  percentTenths: "846",
  status: "ON_TRACK",
  projectionPaise: null,
  overAtPace: false,
  rollover: false,
  startMonth: "2026-05-01",
  endMonth: null,
  drillHref: "/transactions?node=n1&flow=spending&from=2026-11-01&to=2026-11-15",
  history: [historyRow(), historyRow({ month: "2026-10-01", usedPaise: "1200000", status: "OVER", drillHref: "/transactions?node=n1&flow=spending&from=2026-10-01&to=2026-10-31" })],
  ...over,
})

const screen = (over: Partial<BudgetsScreen> = {}): BudgetsScreen => ({
  today: "2026-11-15",
  month: "2026-11-01",
  months: ["2026-09-01", "2026-10-01", "2026-11-01"],
  cards: [card()],
  empty: false,
  upcoming: [],
  ...over,
})

const upcoming = (over: Partial<UpcomingBudget> = {}): UpcomingBudget => ({
  budgetId: "u1",
  nodeId: "n9",
  name: "Rent",
  amountPaise: "2500000",
  startMonth: "2026-12-01",
  endMonth: null,
  rollover: false,
  archived: false,
  ...over,
})

/** All the text, the screen-reader-only parts included: what a link or button is announced as. */
const accessibleText = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'")
/** What is on screen: without the text that only a screen reader reads. */
const visibleText = (html: string) => accessibleText(html.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, ""))
const decode = (value: string) => value.replace(/&amp;/g, "&")

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
  [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [decode(m[1]), accessibleText(m[2]).replace(/\s+/g, " ").trim()])

const renderCard = (over: Partial<BudgetCard> = {}, month = "2026-11-01") =>
  renderToStaticMarkup(createElement(BudgetCardItem, { card: card(over), month, index: 0, announce }))

describe("a budget card", () => {
  it("shows the ledger, the cap, what was used and what is left, as the ledger prints amounts", () => {
    const html = renderCard()
    const text = visibleText(html)
    expect(text).toContain("Groceries")
    expect(text).toContain("₹10,000.00")
    expect(text).toContain("₹8,460.00")
    expect(text).toContain("₹1,540.00")
    expect(text).toContain("84.6%")
    expect(html).toContain("figures")
  })

  it.each([
    ["ON_TRACK", /On track/],
    ["NEAR", /Near limit/],
    ["OVER", /Over budget/],
  ] as const)("says %s in words on the chip, never by colour alone", (status, chip) => {
    expect(visibleText(renderCard({ status }))).toMatch(chip)
  })

  it("says how far over, with the amount, when over, and never claims remaining", () => {
    const text = visibleText(renderCard({ status: "OVER", usedPaise: "1250000", remainingPaise: "-250000", percentTenths: "1250" }))
    expect(text).toMatch(/over by\s*₹2,500\.00/i)
    expect(text).toContain("₹12,500.00")
    expect(text).not.toMatch(/Remaining/)
  })

  it("shows a net refund as negative used, with no 'over', an empty bar and no percent", () => {
    const html = renderCard({ usedPaise: "-50000", remainingPaise: "1050000", percentTenths: null, status: "ON_TRACK" })
    const text = visibleText(html)
    expect(text).toContain("-₹500.00")
    expect(text).toMatch(/net refund/i)
    expect(text).not.toMatch(/\bover\b/i)
    expect(text).not.toContain("%")
    expect(html).toMatch(/data-bar="0"/)
    expect(html).toMatch(/style="width:0%"/)
  })

  it("shows no percent when there is none to show, and still says over when over", () => {
    const text = visibleText(renderCard({ availablePaise: "0", amountPaise: "0", usedPaise: "100", remainingPaise: "-100", percentTenths: null, status: "OVER" }))
    expect(text).not.toContain("%")
    expect(text).toMatch(/over by\s*₹1\.00/i)
  })

  it("shows the projection only when there is one, and says when it is over at this pace", () => {
    expect(visibleText(renderCard())).not.toMatch(/at this pace/i)
    expect(visibleText(renderCard({ projectionPaise: "950000" }))).toMatch(/At this pace: ₹9,500\.00 by month end/)
    const over = visibleText(renderCard({ projectionPaise: "1300000", overAtPace: true }))
    expect(over).toMatch(/over at this pace/i)
    expect(over).toContain("₹13,000.00")
    expect(visibleText(renderCard({ projectionPaise: "950000" }))).not.toMatch(/over at this pace/i)
  })

  it("clamps the bar at 100% for 250% used while the figures stay honest", () => {
    const html = renderCard({ status: "OVER", usedPaise: "2500000", remainingPaise: "-1500000", percentTenths: "2500" })
    expect(html).toMatch(/data-bar="100"/)
    expect(html).toMatch(/style="width:100%"/)
    expect(visibleText(html)).toContain("250.0%")
    expect(visibleText(html)).toContain("₹25,000.00")
  })

  it("sizes the bar to the share used below the cap", () => {
    expect(renderCard()).toMatch(/style="width:84\.6%"/)
    expect(barWidth({ usedPaise: "0", availablePaise: "1000" })).toBe("0")
    expect(barWidth({ usedPaise: "1000", availablePaise: "1000" })).toBe("100")
    // Spent against nothing available is a full bar; nothing spent against nothing is an empty one.
    expect(barWidth({ usedPaise: "5", availablePaise: "0" })).toBe("100")
    expect(barWidth({ usedPaise: "0", availablePaise: "0" })).toBe("0")
  })

  it("formats the percent from tenths as text, exactly", () => {
    expect(percentText("846")).toBe("84.6%")
    expect(percentText("1000")).toBe("100.0%")
    expect(percentText("5")).toBe("0.5%")
    expect(percentText("0")).toBe("0.0%")
    expect(percentText(null)).toBeNull()
  })

  it("names the sub-ledgers a parent counts", () => {
    const text = visibleText(renderCard({ name: "Food", countedNames: ["Groceries", "Eating out"] }))
    expect(text).toMatch(/includes 2 sub-ledgers/i)
    expect(text).toContain("Groceries")
    expect(text).toContain("Eating out")
    expect(visibleText(renderCard({ name: "Food", countedNames: ["Groceries"] }))).toMatch(/includes 1 sub-ledger\b/i)
    expect(visibleText(renderCard())).not.toMatch(/includes/i)
  })

  it("marks an archived ledger in text", () => {
    expect(visibleText(renderCard({ archived: true }))).toContain("Archived")
    expect(visibleText(renderCard())).not.toContain("Archived")
  })

  it("shows what was carried over only when rollover is on and the carry is above zero", () => {
    const carried = visibleText(renderCard({ rollover: true, carryPaise: "120000", availablePaise: "1120000" }))
    expect(carried).toMatch(/\+\s*₹1,200\.00 carried over/)
    expect(visibleText(renderCard({ rollover: true }))).not.toMatch(/carried over/)
    expect(visibleText(renderCard({ rollover: false, carryPaise: "120000" }))).not.toMatch(/carried over/)
  })

  it("links the used amount to the card's drill link, unchanged", () => {
    const href = "/transactions?node=n1&node=n9&flow=spending&from=2026-11-01&to=2026-11-15"
    const found = links(renderCard({ drillHref: href })).find(([, name]) => name.includes("₹8,460.00"))
    expect(found?.[0]).toBe(href)
    expect(found?.[1]).toMatch(/Groceries/)
  })

  it("gives every link and button the ledger's name, for a screen reader", () => {
    const html = renderCard()
    expect(links(html)).toContainEqual(["/budgets/b1/edit", "Edit Groceries budget"])
    expect(buttonNamed(html, "Delete Groceries budget")).toBeDefined()
    expect(buttonNamed(html, /Past months/)?.name).toMatch(/Groceries/)
    expect(buttonNamed(html, /Past months/)?.attrs).toContain('aria-expanded="false"')
  })

  it("names the month the card is for, not 'this month', in the Used link's screen-reader text", () => {
    const past = accessibleText(renderCard({}, "2026-10-01"))
    expect(past).toContain("Groceries spending in Oct 2026, see the entries")
    expect(past).not.toContain("this month")
    expect(accessibleText(renderCard())).toContain("Groceries spending in Nov 2026, see the entries")
    const found = links(renderCard({}, "2026-10-01")).find(([, name]) => name.includes("₹8,460.00"))
    expect(found?.[1]).toMatch(/spending in Oct 2026/)
  })

  it("puts Delete behind a confirm: nothing destructive is on offer until it is pressed", () => {
    const html = renderCard()
    expect(buttonNamed(html, /^Delete budget/)).toBeUndefined()
    expect(visibleText(html)).not.toMatch(/Keep it/)
  })

  it("offers no Past months disclosure for a budget with a single month", () => {
    const html = renderCard({ history: [historyRow()] })
    expect(buttonNamed(html, /Past months/)).toBeUndefined()
  })

  it("prints an eighteen-digit amount to the paisa: paise text never becomes a JS number", () => {
    const html = renderCard({
      amountPaise: "123456789012345678",
      availablePaise: "123456789012345678",
      usedPaise: "123456789012345677",
      remainingPaise: "1",
      percentTenths: "1000",
      status: "NEAR",
    })
    const text = visibleText(html)
    expect(text).toContain("₹1,23,45,67,89,01,23,456.78")
    expect(text).toContain("₹1,23,45,67,89,01,23,456.77")
    expect(html).not.toContain("e+")
    expect(html).not.toContain("NaN")
  })

  it("lets a long name wrap beside a long amount instead of pushing the card wider", () => {
    const html = renderCard({ name: "A very long ledger name that goes on and on and on", usedPaise: "123456789012345678" })
    expect(html).toMatch(/min-w-0/)
    expect(html).toMatch(/break-words|\[overflow-wrap:anywhere\]/)
  })
})

describe("the label of a span of months", () => {
  it("names one month once, a run of months as from-to, and an open end as onwards", () => {
    expect(spanLabel("2026-10-01", "2026-10-01")).toBe("Oct 2026")
    expect(spanLabel("2026-08-01", "2026-10-01")).toBe("Aug 2026 to Oct 2026")
    expect(spanLabel("2026-08-01", null)).toBe("Aug 2026 onwards")
    expect(cardDeleteText({ startMonth: "2026-10-01", endMonth: "2026-10-01" })).toContain("This removes the budget for Oct 2026.")
  })
})

describe("what the delete confirm says", () => {
  it("says the earlier months keep their earlier budget, naming where this one starts, not that its history goes", () => {
    const text = cardDeleteText({ startMonth: "2026-05-01", endMonth: null })
    expect(text).toBe("This removes the budget for May 2026 onwards. Months before May 2026 keep their earlier budget. Your transactions are not touched.")
    expect(text).not.toMatch(/history/i)
    expect(cardDeleteText({ startMonth: "2026-03-01", endMonth: "2026-04-01" })).toContain("Months before Mar 2026 keep their earlier budget.")
  })

  it("says an upcoming budget has not started and touches no transactions", () => {
    expect(upcomingDeleteText({ startMonth: "2026-12-01", endMonth: "2027-02-01" })).toBe(
      "This removes the budget for Dec 2026 to Feb 2027, which has not started. Your transactions are not touched.",
    )
  })
})

describe("the history table", () => {
  const table = (rows: BudgetHistoryRow[]) => renderToStaticMarkup(createElement(HistoryTable, { name: "Groceries", rows }))

  it("lists every month with used, available, its status in words and a drill link", () => {
    const rows = [
      historyRow(),
      historyRow({ month: "2026-10-01", usedPaise: "1200000", status: "OVER", drillHref: "/transactions?node=n1&flow=spending&from=2026-10-01&to=2026-10-31" }),
      historyRow({ month: "2026-09-01", usedPaise: "900000", status: "NEAR", drillHref: "/transactions?node=n1&flow=spending&from=2026-09-01&to=2026-09-30" }),
    ]
    const html = table(rows)
    const text = visibleText(html)
    for (const label of ["Nov 2026", "Oct 2026", "Sep 2026"]) expect(text).toContain(label)
    expect(text).toContain("₹12,000.00")
    expect(text).toContain("₹10,000.00")
    expect(text).toMatch(/On track/)
    expect(text).toMatch(/Near limit/)
    expect(text).toMatch(/Over budget/)
    expect(html.match(/<tr/g)).toHaveLength(4) // the header and three months
    const hrefs = links(html).map(([href]) => href)
    for (const row of rows) expect(hrefs).toContain(row.drillHref)
    expect(html).toContain("<caption")
    expect(accessibleText(html)).toMatch(/Groceries/)
  })
})

describe("the month picker", () => {
  const months = ["2026-09-01", "2026-10-01", "2026-11-01"]
  const picker = (month: string) => renderToStaticMarkup(createElement(MonthPicker, { month, months }))

  it("has no previous link at the first month, and a next link", () => {
    const found = links(picker("2026-09-01"))
    expect(found.some(([, name]) => /Previous/.test(name))).toBe(false)
    expect(found).toContainEqual(["/budgets?month=2026-10", expect.stringContaining("Next")])
  })

  it("has no next link at the current month, and a previous link", () => {
    const found = links(picker("2026-11-01"))
    expect(found.some(([, name]) => /Next/.test(name))).toBe(false)
    expect(found).toContainEqual(["/budgets?month=2026-10", expect.stringContaining("Previous")])
  })

  it("has both in between, naming the month they lead to", () => {
    const found = links(picker("2026-10-01"))
    expect(found).toContainEqual(["/budgets?month=2026-09", "Previous month, Sep 2026"])
    expect(found).toContainEqual(["/budgets?month=2026-11", "Next month, Nov 2026"])
  })

  it("has a select of the bounded months that works as a plain GET form, with the shown month chosen", () => {
    const html = picker("2026-10-01")
    expect(html).toMatch(/<form[^>]*action="\/budgets"[^>]*method="get"/i)
    expect(html).toMatch(/<select[^>]*name="month"/)
    expect(html.match(/<option/g)).toHaveLength(3)
    expect(html).toMatch(/<option[^>]*value="2026-10"[^>]*selected/)
    expect(html).not.toContain('value="2026-12"')
    expect(buttonNamed(html, "Show")).toBeDefined()
  })

  it("has a labelled select", () => {
    expect(picker("2026-10-01")).toMatch(/<label[^>]*for="[^"]+"[^>]*>[\s\S]*Month[\s\S]*<\/label>/)
  })
})

describe("the screen", () => {
  const render = (view: BudgetsScreen) => renderToStaticMarkup(createElement(BudgetsWorkspace, { screen: view }))

  it("has a Budgets heading, a New budget link, the picker and a card per budget", () => {
    const html = render(screen({ cards: [card(), card({ budgetId: "b2", name: "Travel" })] }))
    expect(html).toMatch(/<h1[^>]*>Budgets<\/h1>/)
    expect(links(html)).toContainEqual(["/budgets/new", expect.stringContaining("New budget")])
    expect(visibleText(html)).toContain("Nov 2026")
    expect(visibleText(html)).toContain("Groceries")
    expect(visibleText(html)).toContain("Travel")
  })

  it("says what a budget is for and links to New budget when the user has none", () => {
    const html = render(screen({ empty: true, months: [], cards: [] }))
    expect(visibleText(html)).toMatch(/spend/i)
    expect(visibleText(html)).toMatch(/limit|cap/i)
    expect(links(html).filter(([href]) => href === "/budgets/new").length).toBeGreaterThan(0)
    expect(html).not.toContain("<select")
  })

  it("says plainly that budgets exist but none has started, naming the first start, and still offers New budget", () => {
    const html = render(screen({ empty: false, months: [], cards: [], upcoming: [upcoming()] }))
    const text = visibleText(html)
    expect(text).toMatch(/Your budgets start next month|Your budgets have not started/i)
    expect(text).toContain("Dec 2026")
    expect(links(html).filter(([href]) => href === "/budgets/new").length).toBeGreaterThan(0)
    // Not the first-budget explanation, and not a month list with nothing in it.
    expect(text).not.toMatch(/what a budget is for|Set a limit/i)
    expect(html).not.toContain("<select")
  })

  it("says 'next month' only when the first start is next month, and the month itself otherwise", () => {
    const next = visibleText(render(screen({ empty: false, months: [], cards: [], month: "2026-11-01", upcoming: [upcoming()] })))
    expect(next).toContain("Your budgets start next month")
    const later = visibleText(render(screen({ empty: false, months: [], cards: [], month: "2026-11-01", upcoming: [upcoming({ startMonth: "2027-03-01" })] })))
    expect(later).toContain("Your budgets start in Mar 2027")
    expect(later).not.toContain("next month")
  })

  it("still says none has started when the first start is not known", () => {
    const text = visibleText(render(screen({ empty: false, months: [], cards: [] })))
    expect(text).toMatch(/none has started/i)
    expect(text).not.toContain("undefined")
  })

  it("lists the upcoming budgets when none has started, each with its ledger, cap and start, and Edit and Delete named for it", () => {
    const html = render(
      screen({
        empty: false,
        months: [],
        cards: [],
        upcoming: [upcoming(), upcoming({ budgetId: "u2", name: "Travel", amountPaise: "100050", startMonth: "2027-02-01", endMonth: "2027-06-01" })],
      }),
    )
    const text = visibleText(html)
    expect(text).toContain("Upcoming")
    expect(html).toMatch(/<h2[^>]*>Upcoming<\/h2>/)
    expect(text).toContain("Rent")
    expect(text).toContain("₹25,000.00")
    expect(text).toContain("Starts Dec 2026")
    expect(text).toContain("Travel")
    expect(text).toContain("₹1,000.50")
    expect(text).toMatch(/Starts Feb 2027.*Jun 2027/)
    expect(links(html)).toContainEqual(["/budgets/u1/edit", "Edit Rent budget"])
    expect(links(html)).toContainEqual(["/budgets/u2/edit", "Edit Travel budget"])
    expect(buttonNamed(html, "Delete Rent budget")).toBeDefined()
    expect(buttonNamed(html, "Delete Travel budget")).toBeDefined()
    expect(html).not.toContain("<select") // still no month list with nothing in it
  })

  it("puts Delete on an upcoming budget behind the same confirm as a card: nothing destructive until it is pressed", () => {
    const html = render(screen({ empty: false, months: [], cards: [], upcoming: [upcoming()] }))
    expect(buttonNamed(html, /^Delete budget/)).toBeUndefined()
    expect(visibleText(html)).not.toMatch(/Keep it/)
    expect(buttonNamed(html, "Delete Rent budget")?.attrs).toContain('aria-expanded="false"')
  })

  it("shows the Upcoming section below the cards when some budgets have started, and none when there is nothing upcoming", () => {
    const withUpcoming = render(screen({ upcoming: [upcoming()] }))
    const cardsAt = withUpcoming.indexOf("Groceries")
    const upcomingAt = withUpcoming.indexOf(">Upcoming<")
    expect(cardsAt).toBeGreaterThan(-1)
    expect(upcomingAt).toBeGreaterThan(cardsAt)
    expect(links(withUpcoming)).toContainEqual(["/budgets/u1/edit", "Edit Rent budget"])
    expect(links(withUpcoming)).toContainEqual(["/budgets/b1/edit", "Edit Groceries budget"])
    expect(visibleText(render(screen()))).not.toContain("Upcoming")
    expect(visibleText(render(screen({ empty: true, months: [], cards: [] })))).not.toContain("Upcoming")
  })

  it("shows the Upcoming section under the no-budget-covers message too, so a month with no card is not a dead end", () => {
    const html = render(screen({ cards: [], month: "2026-10-01", upcoming: [upcoming()] }))
    expect(visibleText(html)).toMatch(/no budget covers Oct 2026/i)
    expect(buttonNamed(html, "Delete Rent budget")).toBeDefined()
  })

  it("marks an upcoming budget on an archived ledger in text, and says when it carries over", () => {
    const text = visibleText(render(screen({ upcoming: [upcoming({ archived: true, rollover: true })] })))
    expect(text).toContain("Archived")
    expect(text).toMatch(/carries over/i)
    expect(visibleText(render(screen({ upcoming: [upcoming()] })))).not.toMatch(/Archived|carries over/i)
  })

  it("says no budget covers the month it is looking at, with the picker still there", () => {
    const html = render(screen({ cards: [], month: "2026-10-01" }))
    expect(visibleText(html)).toMatch(/no budget covers Oct 2026/i)
    expect(html).toContain("<select")
  })
})

describe("the page", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("u1")
    loadBudgetsScreen.mockReset().mockResolvedValue(screen())
    redirect.mockReset()
  })

  const open = (month?: string | string[]) => BudgetsPage({ searchParams: Promise.resolve(month === undefined ? {} : { month }) })

  it("reads the month from the URL as the first of that month", async () => {
    await open("2026-09")
    expect(loadBudgetsScreen).toHaveBeenCalledWith("u1", "2026-09-01")
  })

  it.each([["garbage"], ["2026-13"], ["2026-00"], ["2026-9"], ["2026-09-15"], ["99999-01"], [""]])(
    "falls back to the current month, without an error, for %j",
    async (month) => {
      await open(month as string | string[])
      expect(loadBudgetsScreen).toHaveBeenCalledWith("u1", undefined)
    },
  )

  it("reads a repeated parameter as its first value, as the other screens do", async () => {
    await open(["2026-09", "2026-10"])
    expect(loadBudgetsScreen).toHaveBeenCalledWith("u1", "2026-09-01")
  })

  it("asks for the current month with no parameter", async () => {
    await open()
    expect(loadBudgetsScreen).toHaveBeenCalledWith("u1", undefined)
  })

  it("sends a missing session to /login", async () => {
    requireUserId.mockRejectedValue(new UnauthenticatedError())
    redirect.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT")
    })
    await expect(open()).rejects.toThrow("NEXT_REDIRECT")
    expect(redirect).toHaveBeenCalledWith("/login")
  })

  it("parses the month parameter strictly", () => {
    expect(monthFromParam("2026-02")).toBe("2026-02-01")
    expect(monthFromParam("2026-2")).toBeUndefined()
    expect(monthFromParam(undefined)).toBeUndefined()
    expect(monthFromParam("2026-02-01")).toBeUndefined()
  })
})

describe("the nav", () => {
  const nav = () => renderToStaticMarkup(createElement(AppNav, { current: "budgets", email: "a@b.test", signOut: async () => {}, pending: 0 }))

  it("has a Budgets destination right after Recurring", () => {
    const found = links(nav())
    const hrefs = found.map(([href]) => href)
    expect(found).toContainEqual(["/budgets", expect.stringContaining("Budgets")])
    expect(hrefs.indexOf("/budgets")).toBe(hrefs.indexOf("/recurring") + 1)
  })

  it("marks it as the current page when on it", () => {
    expect(nav()).toMatch(/href="\/budgets"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/budgets"/)
  })
})

describe("the new files", () => {
  const dir = join(process.cwd(), "src/app/budgets")
  const files = readdirSync(dir).filter((name) => name.endsWith(".tsx") || name === "budget-text.ts")

  it("exist", () => {
    for (const name of ["page.tsx", "loading.tsx", "month-picker.tsx", "budget-card.tsx", "history-table.tsx", "budgets-workspace.tsx"]) {
      expect(files).toContain(name)
    }
  })

  it("use the Graphite and Azure tokens only: no raw colours, no purple, no yellow", () => {
    for (const name of files) {
      const source = readFileSync(join(dir, name), "utf8")
      expect(source, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(source, name).not.toMatch(/\b(rgb|rgba|hsl|oklch)\(/)
      expect(source, name).not.toMatch(/\b(?:bg|text|border|ring|from|via|to|fill|stroke|outline|shadow)-(?:purple|violet|indigo|fuchsia|yellow|amber|lime|red|green|blue|orange)(?:-\d+)?\b/)
    }
  })
})
