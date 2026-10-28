import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures"
import { entries } from "./screens"
import { account, buy, incomeSource, investment, nodeId, post, price, today } from "./seed"

// The reports (spec §8.3), driven through a real browser against a real server and database: every report opens on a
// range named in its URL, a figure on a report opens a list of entries that adds up to it, the range control moves the
// URL, and the dashboard's month strip and trend lead into the reports. The ledgers are seeded with dates in 2026 and the
// URLs name a custom range, so nothing here depends on what day the suite runs (the dashboard's strip is the one
// exception: it is the user's real month, so its entries are dated today). Every expected figure is a literal worked out
// by hand below; none is read back from the application, and none is computed by code the application shares.

const QUARTER = "range=custom&from=2026-01-01&to=2026-03-31"

const TABS = [
  ["net-worth", "Net worth"],
  ["cash-flow", "Income vs expense"],
  ["spending", "Spending"],
  ["income", "Income"],
  ["accounts", "Account history"],
  ["investments", "Investment growth"],
] as const

const tabs = (page: Page) => page.getByRole("navigation", { name: "Reports", exact: true })
const rangeForm = (page: Page) => page.getByRole("form", { name: "Report range" })
/**
 * A drill link's accessible name: the figure, then what it is of, which only a screen reader hears (", total spending").
 * The browser puts a space between the two, since the second is placed apart from the first.
 */
const drill = (figure: string, context: string) => ({ name: new RegExp(`^${escaped(figure)}\\s*${escaped(context)}$`) })
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** One figure of the income vs expense card, by its label ("Income", "Spending", "Net saved"). */
const flowFigure = (page: Page, label: string) =>
  page.getByRole("region", { name: /^Income vs expense,/ }).locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]")
/** The filtered total on the Transactions screen: "Net into these ledgers ₹19,000.00". */
const filteredTotal = (page: Page) => page.locator("p").filter({ hasText: /^Net (into|out of) these ledgers/ })

/** Open a report and wait for the real page (its tabs and range control), not the loading skeleton. */
async function openReport(page: Page, slug: string, query = QUARTER) {
  await page.goto(`/reports/${slug}?${query}`)
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible()
  await expect(rangeForm(page)).toBeVisible()
}

/**
 * The quarter every test below starts from, in rupees:
 *
 *   5 Jan   Salary -> Bank      50,000.00     income
 *   10 Jan  Bank -> Groceries    4,000.00     spending
 *   20 Jan  Bank -> Rent        15,000.00     spending
 *
 *   Income 50,000.00; spending 4,000.00 + 15,000.00 = 19,000.00; saved 50,000.00 - 19,000.00 = 31,000.00.
 *   Rent's share of the spending: 15,000 / 19,000 = 78.947...%, shown as 78.9%.
 */
async function seedQuarter(userId: string) {
  await account(userId, "Bank")
  await incomeSource(userId, "Salary")
  await post(userId, "Salary", "Bank", "50,000", { date: "2026-01-05" })
  await post(userId, "Bank", "Groceries", "4,000", { date: "2026-01-10" })
  await post(userId, "Bank", "Rent", "15,000", { date: "2026-01-20" })
}

test("every report opens on the range in its URL, with its tabs and its key figure", async ({ session: { page, userId } }) => {
  await seedQuarter(userId)
  // And, for the balance reports: 2 g of gold for ₹10,000 out of the bank on 10 Jan, priced at ₹6,000 a gram only from
  // 15 Feb, and ₹1,000 moved to a wallet on 1 Feb.
  //
  //   Bank    50,000.00 - 4,000.00 - 10,000.00 - 15,000.00 = 21,000.00 at the end of January; - 1,000.00 = 20,000.00 after
  //   Wallet  1,000.00 from 1 Feb
  //   Gold    not valued at the end of January (no price yet); 2 x 6,000.00 = 12,000.00 from February, a gain of 2,000.00
  //   Net worth: January 21,000.00 (the gold left out); February and March 20,000.00 + 1,000.00 + 12,000.00 = 33,000.00
  await account(userId, "Wallet")
  await investment(userId, "Gold", { unit: "g" })
  await buy(userId, "Bank", "Gold", "10,000", "2", "2026-01-10")
  await post(userId, "Bank", "Wallet", "1,000", { date: "2026-02-01" })
  await price(userId, "Gold", "6,000", "2026-02-15")

  for (const [slug, label] of TABS) {
    await openReport(page, slug)
    // One tab per report, each keeping the range; only the current one is marked current.
    for (const [other, otherLabel] of TABS) {
      const tab = tabs(page).getByRole("link", { name: otherLabel, exact: true })
      await expect(tab).toHaveAttribute("href", `/reports/${other}?${QUARTER}`)
      if (other === slug) await expect(tab, label).toHaveAttribute("aria-current", "page")
      else await expect(tab, `${otherLabel} on ${label}`).not.toHaveAttribute("aria-current", /./)
    }
    await expect(rangeForm(page).getByRole("radio", { name: "Custom" })).toBeChecked()
    await expect(rangeForm(page)).toContainText("Showing 1 Jan 2026 to 31 Mar 2026.")
  }

  // Income vs expense.
  await openReport(page, "cash-flow")
  const flow = page.getByRole("region", { name: "Income vs expense, 1 Jan 2026 to 31 Mar 2026" })
  await expect(flow.getByRole("link", drill("₹50,000.00", ", total income"))).toBeVisible()
  await expect(flow.getByRole("link", drill("₹19,000.00", ", total spending"))).toBeVisible()
  await expect(flowFigure(page, "Net saved")).toHaveText("₹31,000.00")
  await expect(page.getByRole("img", { name: /^Income and spending by month\./ })).toBeVisible()

  // Spending, ranked: Rent first.
  await openReport(page, "spending")
  const spent = page.getByRole("figure", { name: /^Where the money went/ }).getByRole("list").first().getByRole("listitem")
  await expect(spent).toHaveCount(2)
  await expect(spent.nth(0)).toContainText("Rent")
  await expect(spent.nth(0)).toContainText("₹15,000.00")
  await expect(spent.nth(0)).toContainText("78.9%")
  await expect(spent.nth(1)).toContainText("Groceries")
  await expect(spent.nth(1)).toContainText("₹4,000.00")
  await expect(page.getByRole("link", { name: /^Total spending/ })).toContainText("₹19,000.00")

  // Income, ranked: Salary, all of it.
  await openReport(page, "income")
  const earned = page.getByRole("figure", { name: /^Where the money came from/ }).getByRole("list").first().getByRole("listitem")
  await expect(earned).toHaveCount(1)
  await expect(earned.nth(0)).toContainText("Salary")
  await expect(earned.nth(0)).toContainText("₹50,000.00")
  await expect(earned.nth(0)).toContainText("100.0%")

  // Account history: the oldest account (Bank) by default, then the wallet, picked and applied with Show.
  await openReport(page, "accounts")
  const picker = page.getByRole("form", { name: "Report account" })
  await expect(picker.getByLabel("Account")).toHaveValue(await nodeId(userId, "Bank"))
  await expect(page.getByRole("img", { name: /^Bank: balance at the end of each day\./ })).toHaveAccessibleName(/closed at ₹20,000\.00 on 31 Mar 2026\.$/)
  await picker.getByLabel("Account").selectOption({ label: "Wallet" })
  await picker.getByRole("button", { name: "Show" }).click()
  await expect(page).toHaveURL(`/reports/accounts?${QUARTER}&node=${await nodeId(userId, "Wallet")}`)
  await expect(page.getByRole("img", { name: /^Wallet: balance at the end of each day\./ })).toHaveAccessibleName(/closed at ₹1,000\.00 on 31 Mar 2026\.$/)

  // Net worth: ₹33,000.00 at the end of the range; January leaves the gold out and says so.
  await openReport(page, "net-worth")
  const latest = page.getByRole("region", { name: "Net worth on 31 Mar 2026" })
  await expect(latest.locator("p").first()).toHaveText("₹33,000.00")
  await expect(latest).toContainText("₹21,000.00 in accounts, ₹12,000.00 invested, ₹0.00 owed.")
  const months = page.getByRole("table", { name: /^Assets, investments, amount owed and net worth at the end of each month/ }).getByRole("rowgroup")
  const january = months.filter({ hasText: "Jan 2026" })
  await expect(january).toContainText("₹21,000.00")
  await expect(january).toContainText("Excludes: Gold (No price yet)")
  await expect(months.filter({ hasText: "Feb 2026" })).toContainText("₹33,000.00")
  await expect(months.filter({ hasText: "Feb 2026" })).not.toContainText("Excludes")

  // Investment growth: ₹10,000.00 in from January, not valued until February's price, then worth ₹12,000.00.
  await openReport(page, "investments")
  const growth = page.getByRole("table", { name: /invested, value, gain and realised by month/ }).getByRole("rowgroup")
  const jan = growth.filter({ hasText: "Jan 2026" }).getByRole("row").first()
  await expect(jan.getByRole("cell").nth(0)).toHaveText("₹10,000.00")
  await expect(jan.getByRole("cell").nth(1)).toHaveText("Not valued")
  // Gain is not valued either: a dash on screen, read as "not valued", never ₹0.00.
  await expect(jan.getByRole("cell").nth(2)).toHaveText(/^—\s*not valued$/)
  await expect(jan.getByRole("cell").nth(2)).not.toContainText("₹")
  await expect(growth.filter({ hasText: "Jan 2026" })).toContainText("Gold not valued in this month.")
  const feb = growth.filter({ hasText: "Feb 2026" }).getByRole("row").first()
  await expect(feb.getByRole("cell").nth(0)).toHaveText("₹10,000.00")
  await expect(feb.getByRole("cell").nth(1)).toHaveText("₹12,000.00")
  await expect(feb.getByRole("cell").nth(2)).toHaveText("₹2,000.00")
  const which = page.getByRole("form", { name: "Report investment" })
  await expect(which.getByLabel("Investment")).toHaveValue("")
  await which.getByLabel("Investment").selectOption({ label: "Gold" })
  await which.getByRole("button", { name: "Show" }).click()
  await expect(page).toHaveURL(`/reports/investments?${QUARTER}&node=${await nodeId(userId, "Gold")}`)
  await expect(page.getByRole("img", { name: /^Gold: invested and value\./ })).toBeVisible()

  // The lots and prices behind the value are on the Investments screen, at Gold's own card.
  await page.getByRole("link", drill("Open Gold in Investments", ", where the lots and prices are listed")).click()
  await expect(page).toHaveURL(`/investments#holding-${await nodeId(userId, "Gold")}`)
  await expect(page.getByRole("region", { name: "Gold", exact: true })).toBeInViewport()
  await page.goBack()
  await which.getByLabel("Investment").selectOption({ label: "All investments" })
  await which.getByRole("button", { name: "Show" }).click()
  await expect(page).toHaveURL(`/reports/investments?${QUARTER}`)
  await expect(page.getByRole("link", drill("Open Investments", ", where the lots and prices are listed"))).toHaveAttribute("href", "/investments")
})

test("a figure opens a list of entries that adds up to it", async ({ session: { page, userId } }) => {
  await seedQuarter(userId)
  const rows = entries(page).getByRole("listitem")

  // The spending total on income vs expense: Rent and Groceries, ₹19,000.00 into them.
  await openReport(page, "cash-flow")
  await page.getByRole("region", { name: /^Income vs expense,/ }).getByRole("link", drill("₹19,000.00", ", total spending")).click()
  await expect(page).toHaveURL("/transactions?flow=spending&from=2026-01-01&to=2026-03-31")
  await expect(filteredTotal(page)).toHaveText("Net into these ledgers ₹19,000.00")
  await expect(rows).toHaveCount(2)

  // January's spending in the month-by-month table: the same entries, over January.
  await openReport(page, "cash-flow")
  await page.getByRole("link", drill("₹19,000.00", ", spending, Jan 2026")).click()
  await expect(page).toHaveURL("/transactions?flow=spending&from=2026-01-01&to=2026-01-31")
  await expect(filteredTotal(page)).toHaveText("Net into these ledgers ₹19,000.00")

  // One ledger on the spending report: Rent's ₹15,000.00 is its one entry.
  await openReport(page, "spending")
  await expect(page.getByRole("listitem").filter({ hasText: "Rent" })).toContainText("₹15,000.00")
  await page.getByRole("link", { name: "Rent", exact: true }).click()
  await expect(page).toHaveURL(`/transactions?node=${await nodeId(userId, "Rent")}&from=2026-01-01&to=2026-03-31`)
  await expect(filteredTotal(page)).toHaveText("Net into these ledgers ₹15,000.00")
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText("Bank → Rent")

  // The income total: what came in is money out of the income sources, ₹50,000.00 of it.
  await openReport(page, "income")
  await page.getByRole("link", { name: /^Total income/ }).click()
  await expect(page).toHaveURL("/transactions?flow=income&from=2026-01-01&to=2026-03-31")
  await expect(filteredTotal(page)).toHaveText("Net out of these ledgers ₹50,000.00")
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText("Salary → Bank")
})

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
/** "2026-10-28" as the reports print it, "28 Oct 2026". Test arithmetic on the test's own date, not the application's. */
const printed = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`

test("the range control puts the range in the URL, and a range it cannot read is said beside it", async ({ session: { page, userId } }) => {
  await seedQuarter(userId)
  // February too: 52,000.00 in and 15,000.00 out. Over the quarter that is 1,02,000.00 in and 34,000.00 out. And 10,000.00
  // in on 10 Apr 2025, so the history begins at the start of the financial year 2025-26, which then holds 1,12,000.00 in.
  await post(userId, "Salary", "Bank", "52,000", { date: "2026-02-05" })
  await post(userId, "Bank", "Rent", "15,000", { date: "2026-02-20" })
  await post(userId, "Salary", "Bank", "10,000", { date: "2025-04-10" })
  const flow = (page: Page) => page.getByRole("region", { name: /^Income vs expense,/ })

  await openReport(page, "cash-flow")
  await expect(flow(page).getByRole("link", drill("₹1,02,000.00", ", total income"))).toBeVisible()
  await expect(flow(page).getByRole("link", drill("₹34,000.00", ", total spending"))).toBeVisible()

  // One month: January alone.
  await rangeForm(page).getByRole("radio", { name: "Month", exact: true }).check()
  await rangeForm(page).getByLabel("Which month").fill("2026-01")
  await rangeForm(page).getByRole("button", { name: "Show" }).click()
  await expect(page).toHaveURL("/reports/cash-flow?range=month-2026-01")
  await expect(rangeForm(page)).toContainText("Showing 1 Jan 2026 to 31 Jan 2026.")
  await expect(flow(page)).toHaveAccessibleName("Income vs expense, 1 Jan 2026 to 31 Jan 2026")
  await expect(flow(page).getByRole("link", drill("₹50,000.00", ", total income"))).toBeVisible()
  await expect(flow(page).getByRole("link", drill("₹19,000.00", ", total spending"))).toBeVisible()

  // One financial year: April 2025 to March 2026, month by month, which holds April's entry and the whole quarter.
  await rangeForm(page).getByRole("radio", { name: "Financial year" }).check()
  await rangeForm(page).getByLabel("Which financial year").selectOption({ label: "FY 2025–26" })
  await rangeForm(page).getByRole("button", { name: "Show" }).click()
  await expect(page).toHaveURL("/reports/cash-flow?range=fy-2025")
  await expect(rangeForm(page)).toContainText("Showing 1 Apr 2025 to 31 Mar 2026.")
  await expect(flow(page).getByRole("link", drill("₹1,12,000.00", ", total income"))).toBeVisible()
  await expect(flow(page).getByRole("link", drill("₹34,000.00", ", total spending"))).toBeVisible()
  const year = page.getByRole("table", { name: "Income, spending and net saved by period, 1 Apr 2025 to 31 Mar 2026" }).getByRole("rowgroup").nth(1).getByRole("row")
  await expect(year).toHaveCount(12)
  await expect(year.first().getByRole("rowheader")).toHaveText("Apr 2025")
  await expect(year.first()).toContainText("₹10,000.00")
  await expect(year.last().getByRole("rowheader")).toHaveText("Mar 2026")

  // The URL survives a change of report: the tabs carry the range.
  await tabs(page).getByRole("link", { name: "Spending", exact: true }).click()
  await expect(page).toHaveURL("/reports/spending?range=fy-2025")
  await expect(page.getByRole("link", { name: /^Total spending/ })).toContainText("₹34,000.00")

  // A month that does not exist: the reason is said beside the control (and tied to it), and the report is the last 12
  // months, the twelve calendar months ending in this one.
  await openReport(page, "cash-flow", "range=month-2026-13")
  const message = '"month-2026-13" is not a recognised date range. Showing the last 12 months instead.'
  await expect(rangeForm(page)).toContainText(message)
  await expect(rangeForm(page).getByRole("group", { name: "Range" })).toHaveAccessibleDescription(message)
  await expect(rangeForm(page).getByRole("radio", { name: "Last 12 months" })).toBeChecked()
  const day = await today(userId)
  const [y, m] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))]
  const start = m === 12 ? `${y}-01-01` : `${y - 1}-${String(m + 1).padStart(2, "0")}-01`
  await expect(rangeForm(page)).toContainText(`Showing ${printed(start)} to ${printed(day)}.`)
  await expect(flow(page)).toHaveAccessibleName(`Income vs expense, ${printed(start)} to ${printed(day)}`)
})

/** What has the keyboard's focus, in words a test can compare. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el) return ""
    const nav = el.closest("nav")?.getAttribute("aria-label") ?? ""
    const kind = el.tagName === "INPUT" ? `${el.tagName}:${(el as HTMLInputElement).type}` : el.tagName
    return `${nav}|${kind}|${el.getAttribute("href") ?? ""}|${el.textContent?.trim() ?? ""}`
  })

test("a report is worked by keyboard, reads in both themes, and keeps still for reduced motion", async ({ session: { page, userId } }) => {
  await seedQuarter(userId)
  await openReport(page, "cash-flow")

  // Tab from the top of the page to the chart's "View as table", noting everything focus lands on along the way.
  const seen: string[] = []
  const summary = page.locator("summary", { hasText: "View as table" })
  await page.locator("body").focus()
  for (let i = 0; i < 80 && !(await summary.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab")
    seen.push(await focused(page))
  }
  for (const [slug, label] of TABS) {
    expect(seen, `the ${label} tab`).toContainEqual(`Reports|A|/reports/${slug}?${QUARTER}|${label}`)
  }
  expect(seen, "the range control").toContainEqual("|INPUT:radio||")
  expect(seen, "the range control's Show").toContainEqual("|BUTTON||Show")
  expect(seen, "a drill link").toContainEqual("|A|/transactions?flow=spending&from=2026-01-01&to=2026-03-31|₹19,000.00, total spending")
  await expect(summary).toBeFocused()
  const table = page.getByRole("table", { name: "Income and spending by month" })
  await expect(table).toBeHidden()
  await page.keyboard.press("Enter")
  await expect(table).toBeVisible()
  await expect(table.getByRole("row").filter({ hasText: "Jan 2026" })).toContainText("₹50,000.00")

  // Both themes, by the real toggle: the chart and its table are drawn in each.
  const chart = page.getByRole("img", { name: /^Income and spending by month\./ })
  const toggle = page.getByRole("complementary").getByRole("button", { name: /^Theme:/ })
  for (const theme of ["light", "dark"]) {
    await toggle.click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
    await expect(chart).toBeVisible()
    await expect(chart.locator("g.chart-grow").first()).toBeVisible()
    await expect(table).toBeVisible()
    await expect(table.getByRole("row").filter({ hasText: "Jan 2026" })).toContainText("₹19,000.00")
  }

  // Motion: with no preference, the chart arrives with its entrance; asked for less, it has none.
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.reload()
  await expect(chart).toHaveClass(/chart-enter/)
  // The entrance's name, not a count of running animations: one may be over before it is counted, and a colour
  // transition elsewhere in the chart counts as one too.
  expect(await chart.locator("g.chart-grow").first().evaluate((bar) => getComputedStyle(bar).animationName)).toBe("chart-grow")

  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.reload()
  // The server cannot know the preference, so the class comes off once the page has hydrated: wait for that.
  await expect(chart).not.toHaveClass(/chart-enter/)
  expect(await chart.locator("g.chart-grow").first().evaluate((bar) => getComputedStyle(bar).animationName)).toBe("none")
})

test("the dashboard's month strip and trend open the reports they summarise", async ({ session: { page, userId } }) => {
  // This month's entries, so they are dated today: 50,000.00 in, 4,000.00 out, 46,000.00 saved; the bank holds 46,000.00.
  await account(userId, "Bank")
  await incomeSource(userId, "Salary")
  await post(userId, "Salary", "Bank", "50,000")
  await post(userId, "Bank", "Groceries", "4,000")
  const day = await today(userId)
  const month = `month-${day.slice(0, 7)}`
  const monthName = `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`

  const strip = async () => {
    await page.goto("/")
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible()
    return page.getByRole("region", { name: "This month", exact: true })
  }
  const tiles = [
    ["Income", "₹50,000.00", "the income report", "income", "Income"],
    ["Spending", "₹4,000.00", "the spending report", "spending", "Spending"],
    ["Net saved", "₹46,000.00", "income vs expense", "cash-flow", "Income vs expense"],
  ] as const
  for (const [label, figure, opens, slug, tab] of tiles) {
    const tile = (await strip()).getByRole("link", { name: `${label} ${figure} in ${monthName}: open ${opens}` })
    await expect(tile).toHaveAttribute("href", `/reports/${slug}?range=${month}`)
    await tile.click()
    await expect(page).toHaveURL(`/reports/${slug}?range=${month}`)
    await expect(tabs(page).getByRole("link", { name: tab, exact: true })).toHaveAttribute("aria-current", "page")
    await expect(rangeForm(page).getByRole("radio", { name: "Month", exact: true })).toBeChecked()
  }
  // The figure each tile showed is the report's for that month.
  await expect(flowFigure(page, "Net saved")).toHaveText("₹46,000.00")
  await openReport(page, "income", `range=${month}`)
  await expect(page.getByRole("link", { name: /^Total income/ })).toContainText("₹50,000.00")
  await openReport(page, "spending", `range=${month}`)
  await expect(page.getByRole("link", { name: /^Total spending/ })).toContainText("₹4,000.00")

  // The net worth card's trend opens the net worth report, whose latest figure is the card's.
  await strip()
  const card = page.getByRole("region", { name: "Net worth", exact: true })
  await expect(card.locator("p").first()).toHaveText("₹46,000.00")
  await card.getByRole("link", { name: /Net worth report/ }).click()
  await expect(page).toHaveURL("/reports/net-worth")
  await expect(tabs(page).getByRole("link", { name: "Net worth", exact: true })).toHaveAttribute("aria-current", "page")
  await expect(page.getByRole("region", { name: /^Net worth on / }).locator("p").first()).toHaveText("₹46,000.00")
})
