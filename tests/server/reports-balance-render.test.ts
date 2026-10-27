import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import type { RangeChoice } from "@/domain/periods"
import type { AccountHistoryView, GrowthPointView, InvestmentGrowthView, NetWorthPointView, NetWorthReportView, RangeView } from "@/lib/report-view"

// What the net worth, account history and investment growth reports say, as markup, from literal views shaped exactly as
// the server sends them: Scenario N (net worth, growth) and Scenario F (account history), January to March 2026 (plan
// "Shared scenarios"). Ids are stand-ins for the nodes' cuids. Rendering to markup has no app router, so it is stubbed.

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}))

const { NetWorthReport } = await import("@/app/reports/net-worth-report")
const { AccountHistoryReport } = await import("@/app/reports/account-history-report")
const { InvestmentGrowthReport } = await import("@/app/reports/investment-growth-report")

/** All the text, the screen-reader-only parts included: what a link is announced as. */
const accessibleText = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
/** What is on screen: without the text that only a screen reader reads. */
const visibleText = (html: string) => accessibleText(html.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, ""))
/** Every link in the markup as [href, visible text, accessible text], in document order. */
const links = (html: string): [string, string, string][] =>
  [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1].replace(/&amp;/g, "&"), visibleText(m[2]), accessibleText(m[2])])
const hrefs = (html: string) => links(html).map(([href]) => href)
const textOf = (html: string, href: string) => links(html).filter(([h]) => h === href).map(([, text]) => text)
const namesOf = (html: string, href: string) => links(html).filter(([h]) => h === href).map(([, , name]) => name)
/** The main table's body rows (a `<tr>` under a `<tbody>` of the report's own table, not the chart's View as table). */
const reportTable = (html: string) => /<table[^>]*data-report-table[^>]*>[\s\S]*?<\/table>/.exec(html)?.[0] ?? ""
const bodyRows = (html: string) => [...reportTable(html).matchAll(/<tr[^>]*data-row[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0])
/** The visible text of the report table's row for `label`, with the notes under it. */
const rowText = (html: string, label: string) => {
  const table = reportTable(html)
  const group = [...table.matchAll(/<tbody[^>]*>[\s\S]*?<\/tbody>/g)].map((m) => m[0]).find((body) => visibleText(body).trimStart().startsWith(label))
  // A space between cells, as a reader would see them.
  return group ? visibleText(group.replace(/<\/t[dh]>/g, " ")).replace(/\s+/g, " ").trim() : ""
}
/** The `d` of each series line, by series key. */
const seriesPath = (html: string, key: string) => new RegExp(`<path[^>]*data-series="${key}"[^>]*\\sd="([^"]*)"`).exec(html)?.[1] ?? null
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length

const expectClean = (html: string) => {
  expect(html).not.toContain("NaN")
  expect(html).not.toContain("undefined")
  expect(html).not.toContain("Infinity")
}

const Q1: RangeView = {
  from: calendarDate("2026-01-01"),
  to: calendarDate("2026-03-31"),
  clampedToToday: false,
  historyBegins: calendarDate("2026-01-02"),
  futureCount: 0,
}
const Q1_CHOICE: RangeChoice = { kind: "custom", from: calendarDate("2026-01-01"), to: calendarDate("2026-03-31") }

const month = (key: string, from: string, to: string, partial = false) => ({ key, from: calendarDate(from), to: calendarDate(to), partial })
const JAN = month("2026-01", "2026-01-01", "2026-01-31")
const FEB = month("2026-02", "2026-02-01", "2026-02-28")
const MAR = month("2026-03", "2026-03-01", "2026-03-31")
const APR = month("2026-04", "2026-04-01", "2026-04-30")

// -- Net worth ---------------------------------------------------------------------------------------------------------------

function worthPoint(bucket: typeof JAN, figures: Pick<NetWorthPointView, "assetsPaise" | "investmentsPaise" | "liabilitiesPaise" | "totalPaise">, over: Partial<NetWorthPointView> = {}): NetWorthPointView {
  const span = { from: bucket.from, to: bucket.to }
  return {
    bucket,
    asOf: bucket.to,
    ...figures,
    partial: false,
    unvalued: [],
    staleNames: [],
    movementDrill: span,
    assetsDrill: { kind: "ASSET", ...span },
    investmentsDrill: { kind: "INVESTMENT", ...span },
    liabilitiesDrill: { kind: "LIABILITY", ...span },
    ...over,
  }
}

// Task 6's Scenario N net worth, as loadNetWorthReport returns it.
const netWorth: NetWorthReportView = {
  range: Q1,
  empty: false,
  points: [
    worthPoint(
      JAN,
      { assetsPaise: "12000000", investmentsPaise: "1000000", liabilitiesPaise: "2000000", totalPaise: "11000000" },
      { partial: true, unvalued: [{ nodeId: "gold", name: "Gold", reason: "NO_PRICE" }] },
    ),
    worthPoint(FEB, { assetsPaise: "8300000", investmentsPaise: "12250000", liabilitiesPaise: "2000000", totalPaise: "18550000" }),
    worthPoint(MAR, { assetsPaise: "14380000", investmentsPaise: "6320000", liabilitiesPaise: "2000000", totalPaise: "18700000" }),
  ],
}

const renderWorth = (view: NetWorthReportView) => renderToStaticMarkup(createElement(NetWorthReport, { view }))

describe("NetWorthReport", () => {
  const html = renderWorth(netWorth)
  const text = visibleText(html)

  it("has a table of Month, Assets, Investments, Owed, Net worth and Entries", () => {
    expect(visibleText(reportTable(html))).toMatch(/Month\s*Assets\s*Investments\s*Owed\s*Net worth\s*Entries/)
    expect(bodyRows(html)).toHaveLength(3)
  })

  it("shows January's partial total with what it leaves out, and why", () => {
    expect(rowText(html, "Jan 2026")).toContain("₹1,10,000.00")
    expect(rowText(html, "Jan 2026")).toContain("Excludes: Gold (No price yet)")
    expect(rowText(html, "Feb 2026")).not.toContain("Excludes")
  })

  it("prints February and March whole", () => {
    expect(rowText(html, "Feb 2026")).toMatch(/Feb 2026 ₹83,000\.00 ₹1,22,500\.00 ₹20,000\.00 ₹1,85,500\.00/)
    expect(rowText(html, "Mar 2026")).toMatch(/Mar 2026 ₹1,43,800\.00 ₹63,200\.00 ₹20,000\.00 ₹1,87,000\.00/)
  })

  it("draws the totals as one line with January's partial point hollow", () => {
    expect(html).toContain('role="img"')
    expect(count(html, /data-point="hollow"/g)).toBe(1)
    expect(count(html, /data-point="solid"/g)).toBe(2)
    expect(html).toMatch(/<circle[^>]*data-point="hollow"[^>]*><title>Jan 2026, Net worth: ₹1,10,000\.00, partial<\/title>/)
    expect(text).toContain("View as table")
  })

  it("links each component to the entries of its month that touch it, and the Entries column to every entry", () => {
    expect(textOf(html, "/transactions?kind=ASSET&from=2026-02-01&to=2026-02-28")).toEqual(["₹83,000.00"])
    expect(textOf(html, "/transactions?kind=INVESTMENT&from=2026-02-01&to=2026-02-28")).toEqual(["₹1,22,500.00"])
    expect(textOf(html, "/transactions?kind=LIABILITY&from=2026-02-01&to=2026-02-28")).toEqual(["₹20,000.00"])
    expect(textOf(html, "/transactions?from=2026-02-01&to=2026-02-28")).toEqual(["View"])
    expect(hrefs(html).every((href) => href.startsWith("/transactions?"))).toBe(true)
  })

  it("names what each figure link is of, for a screen reader", () => {
    expect(namesOf(html, "/transactions?kind=ASSET&from=2026-01-01&to=2026-01-31")).toEqual(["₹1,20,000.00, assets, Jan 2026"])
    expect(namesOf(html, "/transactions?kind=INVESTMENT&from=2026-02-01&to=2026-02-28")).toEqual(["₹1,22,500.00, investments, Feb 2026"])
    expect(namesOf(html, "/transactions?kind=LIABILITY&from=2026-03-01&to=2026-03-31")).toEqual(["₹20,000.00, owed, Mar 2026"])
    expect(namesOf(html, "/transactions?from=2026-03-01&to=2026-03-31")).toEqual(["View every entry of Mar 2026"])
    for (const [href, shown, name] of links(html)) expect(name, href).not.toBe(shown)
  })

  it("opens with the latest net worth, whole", () => {
    expect(text).toMatch(/Net worth on 31 Mar 2026\s*₹1,87,000\.00/)
    expect(text).not.toContain("Partial figure")
  })

  it("says the price is old on a month valued at a stale price", () => {
    const stale = renderWorth({
      ...netWorth,
      range: { ...Q1, to: calendarDate("2026-04-30") },
      points: [
        ...netWorth.points,
        worthPoint(APR, { assetsPaise: "14380000", investmentsPaise: "6320000", liabilitiesPaise: "2000000", totalPaise: "18700000" }, { staleNames: ["Gold"] }),
      ],
    })
    expect(rowText(stale, "Apr 2026")).toContain("Gold is valued at a price more than its stale window old.")
    expect(rowText(stale, "Mar 2026")).not.toContain("stale window")
    expect(stale).toMatch(/<title>Apr 2026, Net worth: ₹1,87,000\.00, at an old price<\/title>/)
    // The latest point is the hero's, so its note is there too, as the dashboard words it.
    expect(visibleText(stale)).toMatch(/Net worth on 30 Apr 2026[\s\S]*Gold is valued at a price more than its stale window old\./)
    expectClean(stale)
  })

  it("says so beside the latest figure when it is partial", () => {
    const partial = renderWorth({ ...netWorth, points: [netWorth.points[0]] })
    expect(visibleText(partial)).toContain("Partial figure: Gold could not be valued and is left out of it.")
    expectClean(partial)
  })

  it("offers a way to start, and no chart, when nothing has been recorded", () => {
    const out = renderWorth({ range: Q1, empty: true, points: [] })
    expect(visibleText(out)).toContain("Nothing to report yet")
    expect(out).not.toContain('role="img"')
    expectClean(out)
  })

  it("prints no NaN or undefined", () => {
    expectClean(html)
  })
})

// -- Account history -----------------------------------------------------------------------------------------------------

const ACCOUNTS: AccountHistoryView["accounts"] = [
  { id: "bank", name: "Bank", kind: "ASSET", archived: false },
  { id: "savings", name: "Savings", kind: "ASSET", archived: true },
  { id: "card", name: "Card", kind: "LIABILITY", archived: false },
]
type Step = AccountHistoryView["steps"][number]
const step = (bucket: typeof JAN, node: string, opening: string, inn: string, out: string, closing: string): Step => ({
  bucket,
  openingPaise: opening,
  inPaise: inn,
  outPaise: out,
  closingPaise: closing,
  drill: { node: [node], from: bucket.from, to: bucket.to },
})

// Task 6's Scenario F account history, monthly (loadAccountHistory over 2025-10-01..2026-03-31, clipped to January).
const bank: AccountHistoryView = {
  range: { ...Q1, historyBegins: calendarDate("2026-01-01") },
  empty: false,
  granularity: "month",
  accounts: ACCOUNTS,
  selected: ACCOUNTS[0],
  steps: [
    step(JAN, "bank", "0", "15000000", "2650000", "12350000"),
    step(FEB, "bank", "12350000", "5080000", "2500000", "14930000"),
    step(MAR, "bank", "14930000", "6100000", "2180000", "18850000"),
  ],
}
const card: AccountHistoryView = {
  ...bank,
  selected: ACCOUNTS[2],
  steps: [
    step(JAN, "card", "0", "500000", "2000000", "-1500000"),
    step(FEB, "card", "-1500000", "0", "250000", "-1750000"),
    step(MAR, "card", "-1750000", "0", "0", "-1750000"),
  ],
}

const pad = (n: number) => String(n).padStart(2, "0")
// January by day: the opening deposit on the 1st, the salary on the 5th, nothing else moving in these rows.
const january: AccountHistoryView = {
  ...bank,
  range: { ...Q1, to: calendarDate("2026-01-31") },
  granularity: "day",
  steps: Array.from({ length: 31 }, (_, i) => {
    const day = `2026-01-${pad(i + 1)}`
    const bucket = month(day, day, day)
    if (i === 0) return step(bucket, "bank", "0", "10000000", "0", "10000000")
    if (i < 4) return step(bucket, "bank", "10000000", "0", "0", "10000000")
    if (i === 4) return step(bucket, "bank", "10000000", "5000000", "0", "15000000")
    return step(bucket, "bank", "15000000", "0", "0", "15000000")
  }),
}

const renderHistory = (view: AccountHistoryView) => renderToStaticMarkup(createElement(AccountHistoryReport, { view, choice: Q1_CHOICE }))

describe("AccountHistoryReport", () => {
  const html = renderHistory(bank)
  const text = visibleText(html)

  it("has a table of Period, Opening, Money in, Money out and Closing, a row per month", () => {
    expect(visibleText(reportTable(html))).toMatch(/Period\s*Opening\s*Money in\s*Money out\s*Closing/)
    expect(bodyRows(html)).toHaveLength(3)
    expect(rowText(html, "Jan 2026")).toBe("Jan 2026 ₹0.00 ₹1,50,000.00 ₹26,500.00 ₹1,23,500.00")
    expect(rowText(html, "Mar 2026")).toBe("Mar 2026 ₹1,49,300.00 ₹61,000.00 ₹21,800.00 ₹1,88,500.00")
  })

  it("links each period to its entries in the account, named for a screen reader", () => {
    expect(textOf(html, "/transactions?node=bank&from=2026-01-01&to=2026-01-31")).toEqual(["Jan 2026"])
    expect(namesOf(html, "/transactions?node=bank&from=2026-02-01&to=2026-02-28")).toEqual(["Feb 2026, entries of Bank"])
    expect(hrefs(html).every((href) => href.startsWith("/transactions?"))).toBe(true)
  })

  it("draws the closing balances as a line", () => {
    expect(html).toContain('role="img"')
    expect(seriesPath(html, "closing")).toMatch(/^M[^M]*$/)
    expect(text).toContain("View as table")
  })

  it("shows a liability's balances as an amount owed, not a negative balance", () => {
    const out = renderHistory(card)
    expect(rowText(out, "Jan 2026")).toBe("Jan 2026 ₹0.00 ₹5,000.00 ₹20,000.00 ₹15,000.00 owed")
    expect(rowText(out, "Feb 2026")).toBe("Feb 2026 ₹15,000.00 owed ₹0.00 ₹2,500.00 ₹17,500.00 owed")
    expect(visibleText(out)).not.toContain("-₹15,000.00")
    expect(out).toMatch(/<title>Jan 2026, Owed: ₹15,000\.00 owed<\/title>/)
    expectClean(out)
  })

  it("renders one row per day for a daily view", () => {
    const out = renderHistory(january)
    expect(bodyRows(out)).toHaveLength(31)
    expect(rowText(out, "5 Jan 2026")).toBe("5 Jan 2026 ₹1,00,000.00 ₹50,000.00 ₹0.00 ₹1,50,000.00")
    expect(textOf(out, "/transactions?node=bank&from=2026-01-05&to=2026-01-05")).toEqual(["5 Jan 2026"])
    expect(visibleText(out)).toContain("Day by day")
    expectClean(out)
  })

  it("offers every account in a labelled picker, archived ones marked, the shown one chosen", () => {
    const select = /<select[^>]*>[\s\S]*?<\/select>/.exec(html)?.[0] ?? ""
    const id = /<select[^>]*id="([^"]+)"/.exec(select)?.[1]
    expect(id).toBeTruthy()
    expect(html).toMatch(new RegExp(`<label[^>]*for="${id}"[^>]*>Account</label>`))
    const options = [...select.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]])
    expect(options).toEqual([
      ["bank", "Bank"],
      ["savings", "Savings (archived)"],
      ["card", "Card"],
    ])
    expect(select).toMatch(/<option[^>]*value="bank"[^>]*selected=""/)
  })

  it("asks for an account when none is chosen", () => {
    const out = renderHistory({ ...bank, selected: null, steps: [] })
    expect(visibleText(out)).toContain("Choose an account")
    expect(out).not.toContain('role="img"')
    expectClean(out)
  })

  it("offers a way to start when nothing has been recorded", () => {
    const out = renderHistory({ ...bank, empty: true, selected: null, steps: [] })
    expect(visibleText(out)).toContain("Nothing to report yet")
    expectClean(out)
  })

  it("prints no NaN or undefined", () => {
    expectClean(html)
  })
})

// -- Investment growth ---------------------------------------------------------------------------------------------------

const INVESTMENTS: InvestmentGrowthView["investments"] = [
  { id: "gold", name: "Gold", archived: false },
  { id: "fund", name: "Fund", archived: true },
]
const growthPoint = (bucket: typeof JAN, node: string[], over: Partial<GrowthPointView>): GrowthPointView => ({
  bucket,
  asOf: bucket.to,
  investedPaise: "0",
  valuePaise: "0",
  gainPaise: "0",
  realisedPaise: "0",
  stale: false,
  covered: null,
  unvaluedNames: [],
  drill: { node, from: bucket.from, to: bucket.to },
  ...over,
})

// Task 6's Scenario N growth, as loadInvestmentGrowth returns it, for the whole portfolio and for Gold.
const BOTH = ["gold", "fund"]
const portfolio: InvestmentGrowthView = {
  range: Q1,
  empty: false,
  investments: INVESTMENTS,
  selected: null,
  points: [
    growthPoint(JAN, BOTH, { investedPaise: "8000000", valuePaise: "1000000", gainPaise: "0", covered: { covered: 1, total: 2 }, unvaluedNames: ["Gold"] }),
    growthPoint(FEB, BOTH, { investedPaise: "11700000", valuePaise: "12250000", gainPaise: "550000", covered: { covered: 2, total: 2 } }),
    growthPoint(MAR, BOTH, { investedPaise: "6100000", valuePaise: "6320000", gainPaise: "220000", realisedPaise: "480000", covered: { covered: 2, total: 2 } }),
  ],
}
const gold: InvestmentGrowthView = {
  ...portfolio,
  selected: { id: "gold", name: "Gold" },
  points: [
    growthPoint(JAN, ["gold"], { investedPaise: "7000000", valuePaise: null, gainPaise: null, unvaluedNames: ["Gold"] }),
    growthPoint(FEB, ["gold"], { investedPaise: "10700000", valuePaise: "11250000", gainPaise: "550000" }),
    growthPoint(MAR, ["gold"], { investedPaise: "5100000", valuePaise: "5320000", gainPaise: "220000", realisedPaise: "480000" }),
  ],
}

const renderGrowth = (view: InvestmentGrowthView) => renderToStaticMarkup(createElement(InvestmentGrowthReport, { view, choice: Q1_CHOICE }))

describe("InvestmentGrowthReport, the whole portfolio", () => {
  const html = renderGrowth(portfolio)

  it("has a table of Month, Invested, Value, Gain and Realised", () => {
    expect(visibleText(reportTable(html))).toMatch(/Month\s*Invested\s*Value\s*Gain\s*Realised/)
    expect(bodyRows(html)).toHaveLength(3)
  })

  it("says January's value covers only one of the two investments, and which is left out", () => {
    const jan = rowText(html, "Jan 2026")
    expect(jan).toMatch(/^Jan 2026 ₹80,000\.00 ₹10,000\.00 ₹0\.00 ₹0\.00/)
    expect(jan).toContain("covers 1 of 2")
    expect(jan).toContain("Gold could not be valued")
    expect(rowText(html, "Feb 2026")).not.toContain("covers")
  })

  it("shows what March's sale realised", () => {
    expect(rowText(html, "Mar 2026")).toBe("Mar 2026 ₹61,000.00 ₹63,200.00 ₹2,200.00 ₹4,800.00")
  })

  it("draws Invested and Value as two lines, January's partial value hollow", () => {
    expect(seriesPath(html, "invested")).toMatch(/^M[^M]*$/)
    expect(seriesPath(html, "value")).toMatch(/^M[^M]*$/)
    expect(count(html, /data-point="hollow"/g)).toBe(1)
    expect(html).toMatch(/<circle[^>]*data-point="hollow"[^>]*><title>Jan 2026, Value: ₹10,000\.00, covers 1 of 2<\/title>/)
    expect(visibleText(html)).toMatch(/Invested[\s\S]*Value/)
  })

  it("links each month to the entries of the investments in it", () => {
    expect(textOf(html, "/transactions?node=gold%2Cfund&from=2026-01-01&to=2026-01-31")).toEqual(["Jan 2026"])
    expect(namesOf(html, "/transactions?node=gold%2Cfund&from=2026-03-01&to=2026-03-31")).toEqual(["Mar 2026, entries of every investment"])
  })

  it("offers All investments first, then each investment, archived ones marked", () => {
    const select = /<select[^>]*>[\s\S]*?<\/select>/.exec(html)?.[0] ?? ""
    const id = /<select[^>]*id="([^"]+)"/.exec(select)?.[1]
    expect(html).toMatch(new RegExp(`<label[^>]*for="${id}"[^>]*>Investment</label>`))
    const options = [...select.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]])
    expect(options).toEqual([
      ["", "All investments"],
      ["gold", "Gold"],
      ["fund", "Fund (archived)"],
    ])
    expect(select).toMatch(/<option[^>]*value=""[^>]*selected=""/)
  })

  it("marks a month valued at a stale price", () => {
    const out = renderGrowth({ ...portfolio, points: [portfolio.points[0], portfolio.points[1], { ...portfolio.points[2], stale: true }] })
    expect(rowText(out, "Mar 2026")).toContain("valued at a price more than its stale window old")
    expect(rowText(out, "Feb 2026")).not.toContain("stale window")
    expect(out).toMatch(/<title>Mar 2026, Value: ₹63,200\.00, at an old price<\/title>/)
    expectClean(out)
  })

  it("prints no NaN or undefined", () => {
    expectClean(html)
  })
})

describe("InvestmentGrowthReport, one investment", () => {
  const html = renderGrowth(gold)

  it("says Not valued for a month it cannot be valued in, never ₹0 or its cost", () => {
    const jan = rowText(html, "Jan 2026")
    expect(jan).toMatch(/^Jan 2026 ₹70,000\.00 Not valued/)
    expect(jan).not.toMatch(/₹0\.00 ₹0\.00$/)
    expect(count(jan, /₹70,000\.00/g)).toBe(1)
    expect(rowText(html, "Feb 2026")).toBe("Feb 2026 ₹1,07,000.00 ₹1,12,500.00 ₹5,500.00 ₹0.00")
    expect(rowText(html, "Mar 2026")).toBe("Mar 2026 ₹51,000.00 ₹53,200.00 ₹2,200.00 ₹4,800.00")
  })

  it("leaves a gap in the value line where it is not valued", () => {
    // January has no point: the line starts at February, while Invested runs through every month.
    expect(count(seriesPath(html, "value") ?? "", /M/g)).toBe(1)
    expect(count(seriesPath(html, "value") ?? "", /L/g)).toBe(1)
    expect(count(seriesPath(html, "invested") ?? "", /L/g)).toBe(2)
    expect(html).not.toMatch(/<title>Jan 2026, Value:/)
    // A month between two valued ones breaks the line in two.
    const between = renderGrowth({
      ...gold,
      points: [
        { ...gold.points[1], bucket: JAN, asOf: JAN.to },
        { ...gold.points[0], bucket: FEB, asOf: FEB.to },
        gold.points[2],
      ],
    })
    expect(count(seriesPath(between, "value") ?? "", /M/g)).toBe(2)
    expect(count(seriesPath(between, "value") ?? "", /L/g)).toBe(0)
    expect(rowText(between, "Feb 2026")).toContain("Not valued")
    expectClean(between)
  })

  it("chooses the investment in the picker, and names its entries", () => {
    expect(html).toMatch(/<option[^>]*value="gold"[^>]*selected=""/)
    expect(namesOf(html, "/transactions?node=gold&from=2026-02-01&to=2026-02-28")).toEqual(["Feb 2026, entries of Gold"])
  })

  it("names the investment when its price is stale", () => {
    const out = renderGrowth({ ...gold, points: [gold.points[0], gold.points[1], { ...gold.points[2], stale: true }] })
    expect(rowText(out, "Mar 2026")).toContain("Gold is valued at a price more than its stale window old.")
  })

  it("prints no NaN or undefined", () => {
    expectClean(html)
  })
})

describe("InvestmentGrowthReport, nothing to show", () => {
  it("offers a way to start when nothing has been recorded", () => {
    const out = renderGrowth({ ...portfolio, empty: true, points: [] })
    expect(visibleText(out)).toContain("Nothing to report yet")
    expectClean(out)
  })

  it("says there are no investments yet rather than charting zeros", () => {
    const zero = growthPoint(JAN, [], { covered: { covered: 0, total: 0 } })
    const out = renderGrowth({ ...portfolio, investments: [], points: [zero] })
    expect(visibleText(out)).toContain("No investments yet")
    expect(out).not.toContain('role="img"')
    expectClean(out)
  })
})
