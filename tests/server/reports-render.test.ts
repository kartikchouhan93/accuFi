import { isValidElement, createElement, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { calendarDate } from "@/domain/calendar-date"
import type { CashFlowView, InvestmentGrowthView, RangeView, RankedRowView, RankedView } from "@/lib/report-view"
import { createRegistry } from "./repositories/fixtures"
import { flowScenario, holdingsScenario, type Scenario } from "./reports/scenarios"

// What the income-vs-expense, spending and income reports say, as markup, from literal views shaped exactly as the
// server sends them (Scenario F, January to March 2026: plan "Shared scenarios"). Then the dispatcher page itself, with
// the session replaced: which report a slug serves, how it reads the range from the URL, and what it does with one it
// cannot use. Rendering to markup has no app router, so the router is stubbed; notFound and redirect stay real.

const { requireUserId, auth, UnauthenticatedError } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), auth: vi.fn(), UnauthenticatedError }
})
vi.mock("@/server/auth", () => ({ requireUserId, auth, UnauthenticatedError, signOut: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}))

const { CashFlowReport } = await import("@/app/reports/cash-flow-report")
const { RankedReport, RankedBreakdown } = await import("@/app/reports/ranked-report")
const { ReportShell } = await import("@/app/reports/report-shell")
const { default: ReportPage, generateMetadata } = await import("@/app/reports/[report]/page")
const { loadAccountHistory, loadCashFlow, loadNetWorthReport, loadRangeOptions } = await import("@/server/services/report-service")
const { NetWorthReport } = await import("@/app/reports/net-worth-report")
const { AccountHistoryReport } = await import("@/app/reports/account-history-report")
const { InvestmentGrowthReport } = await import("@/app/reports/investment-growth-report")
const { RangeControl } = await import("@/app/reports/range-control")

/** All the text, the screen-reader-only parts included: what a link is announced as. */
const accessibleText = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&")
/** What is on screen: without the text that only a screen reader reads. */
const visibleText = (html: string) => accessibleText(html.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, ""))
/** Every link in the markup as [href, visible text, accessible text], in document order. */
const links = (html: string): [string, string, string][] =>
  [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1].replace(/&amp;/g, "&"), visibleText(m[2]), accessibleText(m[2])])
const hrefs = (html: string) => links(html).map(([href]) => href)
const textOf = (html: string, href: string) => links(html).filter(([h]) => h === href).map(([, text]) => text)
const namesOf = (html: string, href: string) => links(html).filter(([h]) => h === href).map(([, , name]) => name)

const expectClean = (html: string) => {
  expect(html).not.toContain("NaN")
  expect(html).not.toContain("undefined")
  expect(html).not.toContain("Infinity")
}

const Q1: RangeView = {
  from: calendarDate("2026-01-01"),
  to: calendarDate("2026-03-31"),
  clampedToToday: false,
  historyBegins: null,
  futureCount: 0,
}

const month = (key: string, from: string, to: string, partial = false) => ({ key, from: calendarDate(from), to: calendarDate(to), partial })
const flows = (from: string, to: string) => ({
  incomeDrill: { flow: "income" as const, from: calendarDate(from), to: calendarDate(to) },
  spendingDrill: { flow: "spending" as const, from: calendarDate(from), to: calendarDate(to) },
})

// Task 5's Scenario F cash flow, as loadCashFlow returns it.
const cashFlow: CashFlowView = {
  range: Q1,
  empty: false,
  buckets: [
    { bucket: month("2026-01", "2026-01-01", "2026-01-31"), incomePaise: "5000000", spendingPaise: "2150000", savedPaise: "2850000", ...flows("2026-01-01", "2026-01-31") },
    { bucket: month("2026-02", "2026-02-01", "2026-02-28"), incomePaise: "5030000", spendingPaise: "1700000", savedPaise: "3330000", ...flows("2026-02-01", "2026-02-28") },
    { bucket: month("2026-03", "2026-03-01", "2026-03-31"), incomePaise: "5200000", spendingPaise: "1280000", savedPaise: "3920000", ...flows("2026-03-01", "2026-03-31") },
  ],
  totals: {
    incomePaise: "15230000",
    spendingPaise: "5130000",
    savedPaise: "10100000",
    gainPaise: "200000",
    lossPaise: "80000",
    ...flows("2026-01-01", "2026-03-31"),
  },
}

const renderCashFlow = (view: CashFlowView) => renderToStaticMarkup(createElement(CashFlowReport, { view }))

describe("CashFlowReport", () => {
  const html = renderCashFlow(cashFlow)
  const text = visibleText(html)

  it("prints the totals of the range", () => {
    expect(text).toContain("₹1,52,300.00")
    expect(text).toContain("₹51,300.00")
    expect(text).toContain("₹1,01,000.00")
  })

  it("has a table of Period, Income, Spending and Net saved with a row per month and a totals row", () => {
    expect(text).toMatch(/Period\s*Income\s*Spending\s*Net saved/)
    expect(text).toMatch(/Jan 2026\s*₹50,000\.00\s*₹21,500\.00\s*₹28,500\.00/)
    expect(text).toMatch(/Feb 2026\s*₹50,300\.00\s*₹17,000\.00\s*₹33,300\.00/)
    expect(text).toMatch(/Mar 2026\s*₹52,000\.00\s*₹12,800\.00\s*₹39,200\.00/)
    expect(text).toMatch(/Total\s*₹1,52,300\.00\s*₹51,300\.00\s*₹1,01,000\.00/)
  })

  it("links every income and spending figure to the entries it is made of", () => {
    expect(textOf(html, "/transactions?flow=spending&from=2026-01-01&to=2026-01-31")).toContain("₹21,500.00")
    expect(textOf(html, "/transactions?flow=income&from=2026-01-01&to=2026-01-31")).toContain("₹50,000.00")
    expect(textOf(html, "/transactions?flow=income&from=2026-02-01&to=2026-02-28")).toContain("₹50,300.00")
    expect(textOf(html, "/transactions?flow=spending&from=2026-03-01&to=2026-03-31")).toContain("₹12,800.00")
    expect(textOf(html, "/transactions?flow=income&from=2026-01-01&to=2026-03-31")).toContain("₹1,52,300.00")
    expect(textOf(html, "/transactions?flow=spending&from=2026-01-01&to=2026-03-31")).toContain("₹51,300.00")
    expect(hrefs(html).every((href) => href.startsWith("/transactions?"))).toBe(true)
  })

  it("names what each figure link is of, for a screen reader, without changing what is shown", () => {
    expect(namesOf(html, "/transactions?flow=spending&from=2026-01-01&to=2026-01-31")).toEqual(["₹21,500.00, spending, Jan 2026"])
    expect(namesOf(html, "/transactions?flow=income&from=2026-02-01&to=2026-02-28")).toEqual(["₹50,300.00, income, Feb 2026"])
    // The hero and the totals row both lead to every entry of the range.
    expect(namesOf(html, "/transactions?flow=income&from=2026-01-01&to=2026-03-31")).toEqual(["₹1,52,300.00, total income", "₹1,52,300.00, total income"])
    expect(namesOf(html, "/transactions?flow=spending&from=2026-01-01&to=2026-03-31")).toEqual(["₹51,300.00, total spending", "₹51,300.00, total spending"])
    // Every figure link says what it is of.
    for (const [href, text, name] of links(html)) expect(name, href).not.toBe(text)
  })

  it("says what realised gains and losses from investment sales are counted in the figures", () => {
    expect(text).toContain("Includes ₹2,000.00 realised gains and ₹800.00 realised losses from investment sales.")
    const none = visibleText(renderCashFlow({ ...cashFlow, totals: { ...cashFlow.totals, gainPaise: "0", lossPaise: "0" } }))
    expect(none).not.toContain("realised")
    const lossOnly = visibleText(renderCashFlow({ ...cashFlow, totals: { ...cashFlow.totals, gainPaise: "0" } }))
    expect(lossOnly).toContain("Includes ₹0.00 realised gains and ₹800.00 realised losses from investment sales.")
  })

  it("keeps the chart and its View as table", () => {
    expect(html).toContain('role="img"')
    expect(text).toContain("View as table")
    expect(html.match(/data-bar=/g)).toHaveLength(6)
  })

  it("labels a partial bucket with the days it covers", () => {
    const partial: CashFlowView = {
      ...cashFlow,
      range: { ...Q1, from: calendarDate("2026-01-10"), to: calendarDate("2026-04-15") },
      buckets: [
        { ...cashFlow.buckets[0], bucket: month("2026-01", "2026-01-10", "2026-01-31", true), ...flows("2026-01-10", "2026-01-31") },
        { ...cashFlow.buckets[1] },
        { ...cashFlow.buckets[2] },
        { bucket: month("2026-04", "2026-04-01", "2026-04-15", true), incomePaise: "0", spendingPaise: "0", savedPaise: "0", ...flows("2026-04-01", "2026-04-15") },
      ],
    }
    const out = renderCashFlow(partial)
    expect(visibleText(out)).toContain("10–31 Jan 2026")
    expect(visibleText(out)).toContain("1–15 Apr 2026")
    expect(textOf(out, "/transactions?flow=spending&from=2026-01-10&to=2026-01-31")).toContain("₹21,500.00")
    expectClean(out)
  })

  it("prints a month that spent more than came in as a negative saving", () => {
    const out = visibleText(
      renderCashFlow({ ...cashFlow, buckets: [{ ...cashFlow.buckets[0], incomePaise: "100000", spendingPaise: "250050", savedPaise: "-150050" }] }),
    )
    expect(out).toMatch(/Jan 2026\s*₹1,000\.00\s*₹2,500\.50\s*-₹1,500\.50/)
  })

  it("labels a month that took more back than it spent as a net refund, on screen and for a screen reader (EC-20)", () => {
    // Only a refund of ₹500.00 in March, nothing spent: spending is -₹500.00.
    const refunded = { ...cashFlow.buckets[2], spendingPaise: "-50000", savedPaise: "5250000" }
    const out = renderCashFlow({ ...cashFlow, buckets: [cashFlow.buckets[0], cashFlow.buckets[1], refunded] })
    expect(visibleText(out)).toMatch(/Mar 2026\s*₹52,000\.00\s*-₹500\.00\s*net refund\s*₹52,500\.00/)
    expect(namesOf(out, "/transactions?flow=spending&from=2026-03-01&to=2026-03-31")).toEqual(["-₹500.00, spending, Mar 2026, net refund"])
    // The visible label is not read twice: the link's name already says it.
    expect(out).toMatch(/<span aria-hidden="true"[^>]*>net refund<\/span>/)
    // A month that spent is not labelled.
    expect(namesOf(out, "/transactions?flow=spending&from=2026-01-01&to=2026-01-31")).toEqual(["₹21,500.00, spending, Jan 2026"])
    expect(visibleText(html)).not.toContain("net refund")
    // The same for the range's total, in the headline and the table's foot.
    const total = renderCashFlow({ ...cashFlow, buckets: [refunded], totals: { ...cashFlow.totals, spendingPaise: "-50000", savedPaise: "5250000" } })
    expect(namesOf(total, "/transactions?flow=spending&from=2026-01-01&to=2026-03-31")).toEqual([
      "-₹500.00, total spending, net refund",
      "-₹500.00, total spending, net refund",
    ])
    expectClean(total)
  })

  it("offers a way to start, and no chart, when nothing has been recorded", () => {
    const zero = { incomePaise: "0", spendingPaise: "0", savedPaise: "0", gainPaise: "0", lossPaise: "0", ...flows("2025-11-01", "2026-10-28") }
    const out = renderCashFlow({ range: { ...Q1, from: calendarDate("2025-11-01"), to: calendarDate("2026-10-28") }, empty: true, buckets: [], totals: zero })
    expect(visibleText(out)).toContain("Nothing to report yet")
    expect(hrefs(out)).toContain("/transactions")
    expect(out).not.toContain('role="img"')
    expectClean(out)
  })

  it("prints no NaN or undefined", () => {
    expectClean(html)
  })
})

// Task 5's Scenario F spending, as loadRanked(…, "EXPENSE") returns it. Ids are stand-ins for the nodes' cuids.
const drill = (...node: string[]) => ({ node, from: Q1.from, to: Q1.to })
const row = (over: Partial<RankedRowView> & Pick<RankedRowView, "id" | "name" | "paise">): RankedRowView => ({
  directPaise: over.paise,
  shareTenths: null,
  archived: false,
  fromSales: false,
  drill: drill(over.id),
  children: [],
  ...over,
})

const groceries = row({ id: "groceries", name: "Groceries", paise: "600000" })
const food = row({ id: "food", name: "Food", paise: "700000", directPaise: "100000", shareTenths: 133, drill: drill("food", "groceries"), children: [groceries] })
const spending: RankedView = {
  range: Q1,
  empty: false,
  kind: "EXPENSE",
  rows: [row({ id: "rent", name: "Rent", paise: "4500000", shareTenths: 852 }), food, row({ id: "loss", name: "Realised Loss", paise: "80000", shareTenths: 15, fromSales: true })],
  refunds: [row({ id: "dining", name: "Dining", paise: "-150000" })],
  totalPaise: "5130000",
  totalDrill: { flow: "spending", from: Q1.from, to: Q1.to },
}

const income: RankedView = {
  range: Q1,
  empty: false,
  kind: "INCOME_SOURCE",
  rows: [
    row({ id: "salary", name: "Salary", paise: "15000000", shareTenths: 985 }),
    row({ id: "gain", name: "Realised Gain", paise: "200000", shareTenths: 13, fromSales: true }),
    row({ id: "interest", name: "Interest", paise: "30000", shareTenths: 2 }),
  ],
  refunds: [],
  totalPaise: "15230000",
  totalDrill: { flow: "income", from: Q1.from, to: Q1.to },
}

const renderRanked = (view: RankedView) => renderToStaticMarkup(createElement(RankedReport, { view }))
/** The markup of the list item whose link reads `name`. */
const itemOf = (html: string, name: string) => html.split("<li").find((part) => new RegExp(`>${name}</a>`).test(part)) ?? ""
const refundsBlock = (html: string) => /<section[^>]*aria-labelledby="net-refunds"[\s\S]*?<\/section>/.exec(html)?.[0] ?? ""

describe("RankedReport, spending", () => {
  const html = renderRanked(spending)
  const text = visibleText(html)

  it("ranks Rent, then Food, then Realised Loss, each with its amount and share", () => {
    expect(text).toMatch(/Rent[\s\S]*₹45,000\.00[\s\S]*85\.2%[\s\S]*Food[\s\S]*₹7,000\.00[\s\S]*13\.3%[\s\S]*Realised Loss[\s\S]*₹800\.00[\s\S]*1\.5%/)
  })

  it("links each name to the entries it is made of, a parent with its children", () => {
    expect(textOf(html, "/transactions?node=rent&from=2026-01-01&to=2026-03-31")).toEqual(["Rent"])
    expect(textOf(html, "/transactions?node=food%2Cgroceries&from=2026-01-01&to=2026-03-31")).toEqual(["Food"])
    expect(textOf(html, "/transactions?node=loss&from=2026-01-01&to=2026-03-31")).toEqual(["Realised Loss"])
  })

  it("lets a parent open to show what it is made of", () => {
    const button = /<button[^>]*aria-expanded="false"[^>]*>[\s\S]*?<\/button>/.exec(itemOf(html, "Food"))?.[0] ?? ""
    // Closed, so it controls nothing yet: the panel is not in the document (Collapse).
    expect(button).not.toContain("aria-controls")
    expect(accessibleText(button)).toContain("Breakdown of Food")
    // Only a row with children has one.
    expect(itemOf(html, "Rent")).not.toContain("<button")
  })

  it("lists net refunds apart, with signed amounts and no share", () => {
    const block = refundsBlock(html)
    expect(visibleText(block)).toContain("Net refunds")
    expect(visibleText(block)).toMatch(/Dining[\s\S]*-₹1,500\.00/)
    expect(textOf(block, "/transactions?node=dining&from=2026-01-01&to=2026-03-31")).toEqual(["Dining"])
    expect(visibleText(block)).not.toContain("%")
    // Dining is a refund, not a ranked row.
    expect(itemOf(html.replace(block, ""), "Dining")).toBe("")
  })

  it("marks a row that came from selling an investment", () => {
    expect(visibleText(itemOf(html, "Realised Loss"))).toContain("from investment sales")
    expect(visibleText(itemOf(html, "Rent"))).not.toContain("from investment sales")
  })

  it("marks an archived row", () => {
    const archived = renderRanked({ ...spending, rows: [{ ...spending.rows[0], archived: true }, ...spending.rows.slice(1)] })
    expect(visibleText(itemOf(archived, "Rent"))).toContain("archived")
    expect(visibleText(itemOf(html, "Rent"))).not.toContain("archived")
  })

  it("ends with the total, linked to every spending entry of the range", () => {
    expect(textOf(html, "/transactions?flow=spending&from=2026-01-01&to=2026-03-31").join(" ")).toContain("₹51,300.00")
    expect(text).toMatch(/Total spending[\s\S]*₹51,300\.00/)
  })

  it("keeps a View as table", () => {
    expect(text).toContain("View as table")
  })

  it("prints no NaN or undefined", () => {
    expectClean(html)
  })
})

describe("RankedBreakdown", () => {
  it("shows the parent's own entries as Direct, then each child, with no share", () => {
    const html = renderToStaticMarkup(createElement(RankedBreakdown, { row: food }))
    const text = visibleText(html)
    expect(text).toMatch(/Direct[\s\S]*₹1,000\.00[\s\S]*Groceries[\s\S]*₹6,000\.00/)
    expect(textOf(html, "/transactions?node=food&from=2026-01-01&to=2026-03-31")).toEqual(["Direct"])
    expect(namesOf(html, "/transactions?node=food&from=2026-01-01&to=2026-03-31")).toEqual(["Direct entries of Food"])
    expect(textOf(html, "/transactions?node=groceries&from=2026-01-01&to=2026-03-31")).toEqual(["Groceries"])
    expect(text).not.toContain("%")
    expect(text).not.toContain("net refund")
    expectClean(html)
  })

  it("signs a child that took in more than it spent and calls it a net refund", () => {
    const refunded = { ...food, paise: "50000", children: [{ ...groceries, paise: "-50000", directPaise: "-50000" }] }
    const text = visibleText(renderToStaticMarkup(createElement(RankedBreakdown, { row: refunded })))
    expect(text).toMatch(/Groceries[\s\S]*-₹500\.00[\s\S]*net refund/)
  })

  it("marks an archived child", () => {
    const text = visibleText(renderToStaticMarkup(createElement(RankedBreakdown, { row: { ...food, children: [{ ...groceries, archived: true }] } })))
    expect(text).toMatch(/Groceries[\s\S]*archived/)
  })
})

describe("RankedReport, income", () => {
  const html = renderRanked(income)
  const text = visibleText(html)

  it("ranks the income sources with their shares and marks realised gains as from sales", () => {
    expect(text).toMatch(/Salary[\s\S]*₹1,50,000\.00[\s\S]*98\.5%[\s\S]*Realised Gain[\s\S]*₹2,000\.00[\s\S]*1\.3%[\s\S]*Interest[\s\S]*₹300\.00[\s\S]*0\.2%/)
    expect(visibleText(itemOf(html, "Realised Gain"))).toContain("from investment sales")
  })

  it("has no refunds block when nothing was refunded, and totals to every income entry", () => {
    expect(refundsBlock(html)).toBe("")
    expect(textOf(html, "/transactions?flow=income&from=2026-01-01&to=2026-03-31").join(" ")).toContain("₹1,52,300.00")
    expect(text).toMatch(/Total income[\s\S]*₹1,52,300\.00/)
    expectClean(html)
  })
})

describe("RankedReport, nothing to rank", () => {
  it("prints no NaN, no percentage and no undefined for a range with no activity", () => {
    for (const view of [
      { ...spending, rows: [], refunds: [], totalPaise: "0" },
      { ...spending, rows: [row({ id: "rent", name: "Rent", paise: "0" })], refunds: [], totalPaise: "0" },
      { ...income, rows: [], refunds: [], totalPaise: "0" },
    ]) {
      const html = renderRanked(view)
      expectClean(html)
      expect(visibleText(html)).not.toContain("%")
      expect(visibleText(html)).toContain("₹0.00")
    }
  })

  it("says nothing was spent only when nothing was, not when everything spent was refunded and more", () => {
    const empty = visibleText(renderRanked({ ...spending, rows: [], refunds: [], totalPaise: "0" }))
    expect(empty).toContain("Nothing was spent in this range.")
    const onlyRefunds = renderRanked({ ...spending, rows: [], totalPaise: "-150000" })
    expect(visibleText(onlyRefunds)).toContain("More was refunded than spent in this range.")
    expect(visibleText(onlyRefunds)).not.toContain("Nothing was spent")
    expect(visibleText(refundsBlock(onlyRefunds))).toContain("Dining")
    const incomeBack = visibleText(renderRanked({ ...income, rows: [], refunds: [row({ id: "salary", name: "Salary", paise: "-10000" })], totalPaise: "-10000" }))
    expect(incomeBack).toContain("More was paid back than came in during this range.")
    expect(incomeBack).not.toContain("Nothing came in")
    expect(visibleText(renderRanked({ ...income, rows: [], refunds: [], totalPaise: "0" }))).toContain("Nothing came in in this range.")
  })

  it("offers a way to start when nothing has been recorded", () => {
    const html = renderRanked({ ...spending, empty: true, rows: [], refunds: [], totalPaise: "0" })
    expect(visibleText(html)).toContain("Nothing to report yet")
    expect(hrefs(html)).toContain("/transactions")
    expectClean(html)
  })
})

// -- The dispatcher -------------------------------------------------------------------------------------------------------

const registry = createRegistry()
afterAll(registry.cleanup)
let scenario: Scenario
let holdings: Scenario
beforeAll(async () => {
  scenario = await flowScenario(registry)
  holdings = await holdingsScenario(registry)
})
beforeEach(() => {
  requireUserId.mockReset()
  auth.mockReset()
})

type Search = Record<string, string | string[] | undefined>
const page = (report: string, search: Search = {}) => ReportPage({ params: Promise.resolve({ report }), searchParams: Promise.resolve(search) })

/** What a call threw for Next to handle (a redirect or a not-found), or null if it returned. */
async function nextSignal(run: () => Promise<unknown>, thrown?: (error: unknown) => void): Promise<string | null> {
  try {
    await run()
  } catch (error) {
    thrown?.(error)
    const digest = (error as { digest?: unknown }).digest
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return `redirect ${digest.split(";")[2]}`
    if (typeof digest === "string" && digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) return `http ${digest.split(";")[1]}`
    throw error
  }
  return null
}

/** The page's element: the shell, with the report as its child. */
async function shellOf(report: string, search: Search = {}) {
  const element = (await page(report, search)) as ReactElement<{
    current: string
    range: unknown
    rangeError: string | null
    choice: unknown
    options: unknown
    children: ReactElement<{ view: unknown; choice?: unknown }>
  }>
  expect(element.type).toBe(ReportShell)
  expect(isValidElement(element.props.children)).toBe(true)
  return element.props
}

describe("the report dispatcher", () => {
  const signIn = () => requireUserId.mockResolvedValue(scenario.user.id)
  const q1Search = { range: "custom", from: "2026-01-01", to: "2026-03-31" }

  it("serves the income-vs-expense report with the range in the URL and the pickers' options", async () => {
    signIn()
    const props = await shellOf("cash-flow", q1Search)
    expect(props.rangeError).toBeNull()
    expect(props.choice).toEqual({ kind: "custom", from: "2026-01-01", to: "2026-03-31" })
    expect(props.options).toEqual(await loadRangeOptions(scenario.user.id))
    expect(props.children.type).toBe(CashFlowReport)
    const view = props.children.props.view as CashFlowView
    expect(view.totals).toMatchObject({ incomePaise: "15230000", spendingPaise: "5130000", savedPaise: "10100000" })
    expect(visibleText(renderToStaticMarkup(props.children))).toContain("₹1,52,300.00")
  })

  it("serves spending and income as ranked reports", async () => {
    signIn()
    const spent = await shellOf("spending", q1Search)
    expect(spent.children.type).toBe(RankedReport)
    expect(spent.children.props.view).toMatchObject({ kind: "EXPENSE", totalPaise: "5130000" })
    const earned = await shellOf("income", q1Search)
    expect(earned.children.props.view).toMatchObject({ kind: "INCOME_SOURCE", totalPaise: "15230000" })
  })

  it("uses the first value of a repeated parameter", async () => {
    signIn()
    const props = await shellOf("cash-flow", { range: ["custom", "last12"], from: ["2026-02-01", "2025-01-01"], to: ["2026-02-28", "2025-12-31"] })
    expect(props.choice).toEqual({ kind: "custom", from: "2026-02-01", to: "2026-02-28" })
    expect((props.children.props.view as CashFlowView).totals.incomePaise).toBe("5030000")
  })

  it("says why a range it cannot read was not used, and shows the last 12 months instead", async () => {
    signIn()
    const props = await shellOf("cash-flow", { range: "month-2026-13" })
    expect(props.rangeError).toBe('"month-2026-13" is not a recognised date range')
    expect(props.choice).toEqual({ kind: "last12" })
    expect(props.children.props.view).toEqual(await loadCashFlow(scenario.user.id, { kind: "last12" }))
  })

  it("does the same for a range it can read but not report on", async () => {
    signIn()
    const props = await shellOf("spending", { range: "custom", from: "2026-03-01", to: "2026-01-01" })
    expect(props.rangeError).toEqual(expect.any(String))
    expect(props.rangeError).not.toBe("")
    expect(props.choice).toEqual({ kind: "last12" })
    expect(props.children.props.view).toMatchObject({ kind: "EXPENSE" })
  })

  it("falls back, with the reason shown, for a custom date that does not exist", async () => {
    signIn()
    const props = await shellOf("cash-flow", { range: "custom", from: "2026-02-30", to: "2026-03-01" })
    expect(props.rangeError).toBe('"2026-02-30" is not a valid "from" date (expected YYYY-MM-DD)')
    expect(props.choice).toEqual({ kind: "last12" })
    expect(props.children.props.view).toEqual(await loadCashFlow(scenario.user.id, { kind: "last12" }))
  })

  it("is not found for an unknown report", async () => {
    signIn()
    for (const slug of ["nope", "reports", "Net-Worth"]) expect(await nextSignal(() => page(slug)), slug).toBe("http 404")
  })

  it("serves net worth over the range in the URL", async () => {
    requireUserId.mockResolvedValue(holdings.user.id)
    const props = await shellOf("net-worth", q1Search)
    expect(props.rangeError).toBeNull()
    expect(props.children.type).toBe(NetWorthReport)
    const view = props.children.props.view as Awaited<ReturnType<typeof loadNetWorthReport>>
    expect(view.points.map((p) => p.totalPaise)).toEqual(["11000000", "18550000", "18700000"])
    expect(visibleText(renderToStaticMarkup(props.children))).toContain("Excludes: Gold (No price yet)")
  })

  it("serves the history of the account in the URL, keeping the range for the picker", async () => {
    signIn()
    const props = await shellOf("accounts", { ...q1Search, node: scenario.nodes.Card.id })
    expect(props.children.type).toBe(AccountHistoryReport)
    expect(props.children.props.choice).toEqual({ kind: "custom", from: "2026-01-01", to: "2026-03-31" })
    const view = props.children.props.view as Awaited<ReturnType<typeof loadAccountHistory>>
    expect(view.selected).toMatchObject({ id: scenario.nodes.Card.id, name: "Card" })
    expect(view.steps.at(-1)?.closingPaise).toBe("-1750000")
    // No node: the oldest live account.
    const plain = await shellOf("accounts", q1Search)
    expect((plain.children.props.view as Awaited<ReturnType<typeof loadAccountHistory>>).selected?.id).toBe(scenario.nodes.Bank.id)
  })

  it("uses the first node of a repeated node parameter", async () => {
    signIn()
    const props = await shellOf("accounts", { ...q1Search, node: [scenario.nodes.Card.id, scenario.nodes.Bank.id] })
    expect((props.children.props.view as Awaited<ReturnType<typeof loadAccountHistory>>).selected?.id).toBe(scenario.nodes.Card.id)
  })

  it("serves investment growth for the portfolio, or for the investment in the URL", async () => {
    requireUserId.mockResolvedValue(holdings.user.id)
    const all = await shellOf("investments", q1Search)
    expect(all.children.type).toBe(InvestmentGrowthReport)
    const view = all.children.props.view as InvestmentGrowthView
    expect(view.selected).toBeNull()
    expect(view.points[0].covered).toEqual({ covered: 1, total: 2 })
    const gold = await shellOf("investments", { ...q1Search, node: holdings.nodes.Gold.id })
    expect((gold.children.props.view as InvestmentGrowthView).points.map((p) => p.valuePaise)).toEqual([null, "11250000", "5320000"])
  })

  it("is not found for another user's account, and says nothing of it", async () => {
    signIn()
    const theirs = await registry.makeNode(holdings.user.id, "ASSET", "Marigold Private Reserve")
    let thrown: unknown
    expect(await nextSignal(() => page("accounts", { ...q1Search, node: theirs.id }), (error) => (thrown = error))).toBe("http 404")
    const said = JSON.stringify({ message: (thrown as Error).message, digest: (thrown as { digest?: unknown }).digest, stack: (thrown as Error).stack })
    expect(said).not.toContain("Marigold")
    expect(said).not.toContain(theirs.id)
    // Their investment, and a node of the wrong kind, under the other balance reports.
    expect(await nextSignal(() => page("investments", { ...q1Search, node: holdings.nodes.Gold.id }))).toBe("http 404")
    expect(await nextSignal(() => page("investments", { ...q1Search, node: scenario.nodes.Bank.id }))).toBe("http 404")
    expect(await nextSignal(() => page("accounts", { ...q1Search, node: scenario.nodes.Salary.id }))).toBe("http 404")
  })

  it("shows a balance report over the last 12 months, with the reason beside the control, for a range it cannot read", async () => {
    signIn()
    const props = await shellOf("accounts", { range: "month-2026-13", node: scenario.nodes.Bank.id })
    expect(props.rangeError).toBe('"month-2026-13" is not a recognised date range')
    expect(props.choice).toEqual({ kind: "last12" })
    expect(props.children.props.view).toEqual(await loadAccountHistory(scenario.user.id, { kind: "last12" }, scenario.nodes.Bank.id))
    const control = renderToStaticMarkup(
      createElement(RangeControl, {
        current: "accounts",
        choice: props.choice as never,
        range: props.range as never,
        options: props.options as never,
        rangeError: props.rangeError,
      }),
    )
    expect(visibleText(control).replaceAll("&quot;", '"')).toContain('"month-2026-13" is not a recognised date range. Showing the last 12 months instead.')

    requireUserId.mockResolvedValue(holdings.user.id)
    const worth = await shellOf("net-worth", { range: "month-2026-13" })
    expect(worth.rangeError).toBe('"month-2026-13" is not a recognised date range')
    expect(worth.children.props.view).toEqual(await loadNetWorthReport(holdings.user.id, { kind: "last12" }))
  })

  it("sends a signed-out visitor, or a session whose user is gone, to the login page", async () => {
    requireUserId.mockRejectedValue(new UnauthenticatedError())
    expect(await nextSignal(() => page("cash-flow"))).toBe("redirect /login")
    requireUserId.mockReset()
    requireUserId.mockResolvedValue(randomUUID())
    expect(await nextSignal(() => page("spending"))).toBe("redirect /login")
  })

  it("titles the page after the report", async () => {
    expect(await generateMetadata({ params: Promise.resolve({ report: "cash-flow" }) })).toEqual({ title: "Income vs expense · Reports" })
    expect(await generateMetadata({ params: Promise.resolve({ report: "spending" }) })).toEqual({ title: "Spending · Reports" })
    expect(await generateMetadata({ params: Promise.resolve({ report: "accounts" }) })).toEqual({ title: "Account history · Reports" })
    expect(await generateMetadata({ params: Promise.resolve({ report: "nope" }) })).toEqual({ title: "Reports" })
  })
})
