import type { Locator, Page } from "@playwright/test"
import { addDays, addMonths, monthOf, type CalendarDate } from "@/domain/calendar-date"
import { expect, test } from "./fixtures"
import { balanceOf, entries, record } from "./screens"
import { account, addExpense, addNode, budget, nodeId, post, today } from "./seed"

// Budgets (spec M5), driven through a real browser against a real server and database. A budget is a monthly cap on an
// expense ledger: it warns and never blocks, and nothing is stored about a month, so every figure is worked out from the
// entries each time. The months and days below are all derived from the user's own `today` (this month, last month, two
// months ago, and a day inside each, never past the 28th so no month clamps it); no test names a month or depends on the day
// of the month. An entry is only ever looked up over an explicit range, never "this month". Every expected figure is a
// literal worked out by hand beside the setup.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

// Written out here rather than imported: a test must not share the code it checks.
/** "Oct 2026", as the screen prints a month. */
const shortMonth = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
/** "October 2026", as the form's sentences print one. */
const longMonth = (month: string) => `${LONG_MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
/** "2026-10", as the month picker and its fields carry one. */
const monthKey = (month: string) => month.slice(0, 7)
/** The first of the month `n` months from the one `day` is in. */
const monthFrom = (day: CalendarDate, n: number) => addMonths(monthOf(day), n)
/** Day number `n` (1 to 28) of the month starting `first`. */
const dayIn = (first: CalendarDate, n: number) => addDays(first, n - 1)

const main = (page: Page) => page.getByRole("main")
const cards = (page: Page) => main(page).getByRole("list", { name: /^Budgets for / }).getByRole("listitem")
/** The card of a budget, by its ledger's name. */
const cardOf = (page: Page, name: string) => cards(page).filter({ has: page.getByRole("heading", { name, exact: true }) })
/** The value under a label of a card: "Used", "Remaining", "Over by" or "Budget". */
const figureOf = (card: Locator, label: string) => card.locator("dl > div").filter({ has: card.page().locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd")
/** The "Past months" table of a card, opened. */
async function openHistory(page: Page, name: string) {
  await cardOf(page, name).getByRole("button", { name: `Past months for ${name}`, exact: true }).click()
  return cardOf(page, name).getByRole("region", { name: `Past months for ${name}` })
}
const monthRow = (history: Locator, month: string) => history.getByRole("row").filter({ has: history.page().getByRole("rowheader", { name: shortMonth(month) }) })
const toast = (page: Page) => page.getByRole("status")
const ledgerBetween = (page: Page, from: string, to: string) => page.goto(`/transactions?from=${from}&to=${to}`)

async function openBudgets(page: Page, month?: string) {
  await page.goto(month === undefined ? "/budgets" : `/budgets?month=${monthKey(month)}`)
  await expect(page.getByRole("heading", { level: 1, name: "Budgets" })).toBeVisible()
}

test("exit criterion: an expense dated last month that crosses the cap turns that month over, by exactly the excess, and deleting it turns it back", async ({
  session: { page, userId },
}) => {
  await account(userId, "Bank", "50,000")
  const day = await today(userId)
  const lastMonth = monthFrom(day, -1)
  const twoAgo = monthFrom(day, -2)
  // ₹5,000 a month from two months ago; ₹3,000 spent last month, so last month ended with ₹2,000 to spare.
  await budget(userId, { ledger: "Groceries", rupees: "5,000", startMonth: twoAgo })
  await post(userId, "Bank", "Groceries", "3,000", { date: dayIn(lastMonth, 5), note: "Weekly shop" })

  await openBudgets(page)
  await expect(cardOf(page, "Groceries")).toHaveCount(1)
  let history = await openHistory(page, "Groceries")
  await expect(history.getByRole("row")).toHaveCount(4) // the header, two months ago, last month, this month
  await expect(monthRow(history, lastMonth)).toContainText("₹3,000.00")
  await expect(monthRow(history, lastMonth)).toContainText("₹5,000.00")
  await expect(monthRow(history, lastMonth)).toContainText("On track")
  await expect(monthRow(history, twoAgo)).toContainText("On track")

  // A second entry, dated inside last month through the transaction form (the date chosen), takes it to ₹5,500: ₹500 over.
  await page.goto("/transactions")
  const crossing = dayIn(lastMonth, 12)
  await record(page, "Bank", "Groceries", "2,500", { date: crossing, note: "Family dinner party" })
  await expect(toast(page)).toContainText(`Groceries is over budget by ₹500.00 in ${shortMonth(lastMonth)}.`) // the entry is dated last month, so it says which month
  await expect(toast(page)).not.toContainText("this month")
  await expect(toast(page)).toContainText("Recorded Bank → Groceries, ₹2,500.00.") // warned, and recorded all the same

  // Last month's own card says over by exactly that, and its used figure leads to entries that add up to it.
  await openBudgets(page, lastMonth)
  let card = cardOf(page, "Groceries")
  await expect(card).toContainText("Over budget")
  await expect(figureOf(card, "Over by")).toHaveText("₹500.00")
  await expect(figureOf(card, "Used")).toContainText("₹5,500.00")
  await expect(figureOf(card, "Budget")).toHaveText("₹5,000.00")
  await figureOf(card, "Used").getByRole("link").click()
  await expect(page).toHaveURL(new RegExp(`from=${lastMonth}&to=${dayIn(lastMonth, 1).slice(0, 8)}\\d\\d$`))
  await expect(page.locator("p").filter({ hasText: "Net into these ledgers" })).toContainText("₹5,500.00")
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Family dinner party" })).toHaveCount(1)

  // The history row on the current month's card agrees, and this month, with nothing spent in it, is untouched.
  await openBudgets(page)
  history = await openHistory(page, "Groceries")
  await expect(monthRow(history, lastMonth)).toContainText("Over budget")
  await expect(monthRow(history, lastMonth)).toContainText("₹5,500.00")
  await expect(monthRow(history, twoAgo)).toContainText("On track")
  await expect(cardOf(page, "Groceries")).toContainText("On track")

  // Delete the entry that crossed the cap: nothing was frozen, so last month is on track again.
  await ledgerBetween(page, lastMonth, dayIn(lastMonth, 28))
  const party = entries(page).getByRole("listitem").filter({ hasText: "Family dinner party" })
  await party.getByRole("button", { expanded: false }).first().click()
  await party.getByRole("button", { name: "Delete" }).click()
  await expect(toast(page)).toContainText("Deleted Bank → Groceries")
  await openBudgets(page)
  history = await openHistory(page, "Groceries")
  await expect(monthRow(history, lastMonth)).toContainText("On track")
  await expect(monthRow(history, lastMonth)).toContainText("₹3,000.00")
  await expect(monthRow(history, lastMonth)).not.toContainText("Over budget")
  await openBudgets(page, lastMonth)
  card = cardOf(page, "Groceries")
  await expect(card).toContainText("On track")
  await expect(figureOf(card, "Remaining")).toHaveText("₹2,000.00")
})

test("create from the form: it starts at 0% used, and recording spending moves used, remaining and the status, warning as it nears and crosses the cap", async ({
  session: { page, userId },
}) => {
  await account(userId, "Bank", "50,000")
  const day = await today(userId)
  const thisMonth = monthFrom(day, 0)

  await openBudgets(page)
  await expect(main(page).getByRole("heading", { level: 2, name: "Set a limit on what you spend" })).toBeVisible()
  await main(page).getByRole("link", { name: "New budget" }).first().click()
  await expect(page.getByRole("heading", { level: 1, name: "New budget" })).toBeVisible()

  const form = page.getByRole("form", { name: "New budget" })
  await form.getByLabel("Ledger", { exact: true }).selectOption({ label: "Groceries" })
  await form.getByLabel("Monthly amount (₹)").fill("10,000")
  await expect(form.getByLabel("Starts in")).toHaveValue(monthKey(thisMonth)) // this month, by default
  await form.getByRole("button", { name: "Create budget" }).click()

  await expect(page).toHaveURL(/\/budgets\?month=/)
  await expect(toast(page)).toContainText("Created a budget of ₹10,000.00 a month for Groceries.")
  await expect(toast(page)).toContainText(`${shortMonth(thisMonth)} onwards.`)
  let card = cardOf(page, "Groceries")
  await expect(card).toHaveCount(1)
  await expect(card).toContainText("0.0% used")
  await expect(card).toContainText("On track")
  await expect(figureOf(card, "Used")).toContainText("₹0.00")
  await expect(figureOf(card, "Remaining")).toHaveText("₹10,000.00")

  // ₹3,000 (30%): no warning, and the figures move.
  await page.goto("/transactions")
  await record(page, "Bank", "Groceries", "3,000")
  await expect(toast(page)).toContainText("Recorded Bank → Groceries, ₹3,000.00.")
  await expect(toast(page)).not.toContainText("budget")
  await openBudgets(page)
  card = cardOf(page, "Groceries")
  await expect(figureOf(card, "Used")).toContainText("₹3,000.00")
  await expect(figureOf(card, "Remaining")).toHaveText("₹7,000.00")
  await expect(card).toContainText("30.0% used")
  await expect(card).toContainText("On track")

  // ₹5,500 more is 85%: near the limit, and said so as the entry is recorded.
  await page.goto("/transactions")
  await record(page, "Bank", "Groceries", "5,500")
  await expect(toast(page)).toContainText("Groceries is at 85% of its budget this month.")
  await openBudgets(page)
  card = cardOf(page, "Groceries")
  await expect(figureOf(card, "Remaining")).toHaveText("₹1,500.00")
  await expect(card).toContainText("85.0% used")
  await expect(card).toContainText("Near limit")

  // ₹2,000 more crosses it: warned by exactly the excess, and recorded regardless (the account moved by every one of them).
  await page.goto("/transactions")
  await record(page, "Bank", "Groceries", "2,000")
  await expect(toast(page)).toContainText("Groceries is over budget by ₹500.00 this month.")
  await expect(balanceOf(page, "Bank")).toContainText("₹39,500.00") // 50,000 - 3,000 - 5,500 - 2,000
  await openBudgets(page)
  card = cardOf(page, "Groceries")
  await expect(card).toContainText("Over budget")
  await expect(figureOf(card, "Over by")).toHaveText("₹500.00")
  await expect(figureOf(card, "Used")).toContainText("₹10,500.00")
  await expect(card).toContainText("105.0% used")
})

test("a parent's budget counts an entry on its sub-ledger, and the sub-ledger's own budget shows it too", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "50,000")
  const day = await today(userId)
  const thisMonth = monthFrom(day, 0)
  const food = await addNode(userId, { kind: "EXPENSE", name: "Food" })
  await addNode(userId, { kind: "EXPENSE", name: "Veg", parentId: food.id })
  await budget(userId, { ledger: "Food", rupees: "2,000", startMonth: thisMonth })
  await budget(userId, { ledger: "Veg", rupees: "500", startMonth: thisMonth })
  await post(userId, "Bank", "Veg", "400", { note: "Vegetables" })
  await post(userId, "Bank", "Food", "100", { note: "Pantry" })

  await openBudgets(page)
  const parent = cardOf(page, "Food")
  await expect(parent).toContainText("Includes 1 sub-ledger: Veg")
  await expect(figureOf(parent, "Used")).toContainText("₹500.00") // 400 on Veg + 100 on Food
  await expect(figureOf(parent, "Remaining")).toHaveText("₹1,500.00")
  await expect(parent).toContainText("On track")

  const child = cardOf(page, "Veg")
  await expect(child).not.toContainText("Includes")
  await expect(figureOf(child, "Used")).toContainText("₹400.00")
  await expect(figureOf(child, "Remaining")).toHaveText("₹100.00")
  await expect(child).toContainText("Near limit") // 80%

  // The parent's used figure leads to exactly the entries it is made of, the child's among them.
  await figureOf(parent, "Used").getByRole("link").click()
  await expect(page.locator("p").filter({ hasText: "Net into these ledgers" })).toContainText("₹500.00")
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Vegetables" })).toHaveCount(1)
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Pantry" })).toHaveCount(1)
})

test("rollover: unspent budget from last month is carried over and added to this month's available amount", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "50,000")
  await addExpense(userId, "Eating out")
  const day = await today(userId)
  const lastMonth = monthFrom(day, -1)
  // Both: ₹4,000 a month from last month, ₹1,500 spent last month. One carries unspent budget over, the other does not.
  await budget(userId, { ledger: "Groceries", rupees: "4,000", startMonth: lastMonth, rollover: true })
  await budget(userId, { ledger: "Eating out", rupees: "4,000", startMonth: lastMonth })
  for (const ledger of ["Groceries", "Eating out"]) await post(userId, "Bank", ledger, "1,500", { date: dayIn(lastMonth, 10) })
  await post(userId, "Bank", "Groceries", "500", { note: "This month's shop" }) // dated today

  await openBudgets(page)
  const rolling = cardOf(page, "Groceries")
  await expect(figureOf(rolling, "Budget")).toContainText("₹4,000.00")
  await expect(figureOf(rolling, "Budget")).toContainText("+ ₹2,500.00 carried over") // 4,000 - 1,500 from last month
  await expect(figureOf(rolling, "Used")).toContainText("₹500.00")
  await expect(figureOf(rolling, "Remaining")).toHaveText("₹6,000.00") // 4,000 + 2,500 - 500
  await expect(rolling).toContainText("7.7% used") // 500 of 6,500 is 7.69%, shown to a tenth

  const flat = cardOf(page, "Eating out")
  await expect(flat).not.toContainText("carried over")
  await expect(figureOf(flat, "Remaining")).toHaveText("₹4,000.00")

  // Last month, the first of the budget, had nothing to carry in: it was measured against the amount alone.
  const history = await openHistory(page, "Groceries")
  await expect(monthRow(history, lastMonth)).toContainText("₹4,000.00")
  await expect(monthRow(history, lastMonth)).toContainText("On track")
})

test("revise from this month: the card takes the new amount now and last month keeps the old one", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "50,000")
  const day = await today(userId)
  const thisMonth = monthFrom(day, 0)
  const lastMonth = monthFrom(day, -1)
  await budget(userId, { ledger: "Groceries", rupees: "5,000", startMonth: lastMonth })
  await post(userId, "Bank", "Groceries", "3,000", { date: dayIn(lastMonth, 8) })

  await openBudgets(page)
  await cardOf(page, "Groceries").getByRole("link", { name: "Edit Groceries budget", exact: true }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Edit budget" })).toBeVisible()
  const amount = page.getByRole("form", { name: "Amount" })
  await expect(amount.getByLabel("Applies from")).toHaveValue(monthKey(thisMonth)) // history is never rewritten by default
  await expect(amount).toContainText(`Changes the amount from ${longMonth(thisMonth)}; earlier months keep the old amount.`)
  await amount.getByLabel("Monthly amount (₹)").fill("8,000")
  await amount.getByRole("button", { name: "Save amount" }).click()

  await expect(page).toHaveURL(/\/budgets\?month=/)
  await expect(toast(page)).toContainText(`Changed the Groceries budget to ₹8,000.00 from ${longMonth(thisMonth)}.`)
  await expect(toast(page)).toContainText("Earlier months keep the old amount.")
  const card = cardOf(page, "Groceries")
  await expect(figureOf(card, "Budget")).toHaveText("₹8,000.00")
  await expect(figureOf(card, "Remaining")).toHaveText("₹8,000.00")
  const history = await openHistory(page, "Groceries")
  await expect(monthRow(history, thisMonth)).toContainText("₹8,000.00")
  await expect(monthRow(history, lastMonth)).toContainText("₹5,000.00") // still measured against what applied then
  await expect(monthRow(history, lastMonth)).toContainText("₹3,000.00")
  await expect(monthRow(history, lastMonth)).not.toContainText("₹8,000.00")
})

test("revise from the start month: the amount is corrected for every month of the budget", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "50,000")
  const day = await today(userId)
  const lastMonth = monthFrom(day, -1)
  const thisMonth = monthFrom(day, 0)
  await budget(userId, { ledger: "Groceries", rupees: "5,000", startMonth: lastMonth })
  await post(userId, "Bank", "Groceries", "3,000", { date: dayIn(lastMonth, 8) })

  await openBudgets(page)
  await cardOf(page, "Groceries").getByRole("link", { name: "Edit Groceries budget", exact: true }).click()
  const amount = page.getByRole("form", { name: "Amount" })
  await amount.getByLabel("Applies from").selectOption(monthKey(lastMonth))
  await expect(amount).toContainText("Corrects the amount for every month of this budget.")
  await amount.getByLabel("Monthly amount (₹)").fill("8,000")
  await amount.getByRole("button", { name: "Save amount" }).click()

  await expect(toast(page)).toContainText("Corrected the Groceries budget to ₹8,000.00 for every month of it.")
  await expect(figureOf(cardOf(page, "Groceries"), "Budget")).toHaveText("₹8,000.00")
  const history = await openHistory(page, "Groceries")
  await expect(monthRow(history, lastMonth)).toContainText("₹8,000.00") // last month is measured against the corrected amount
  await expect(monthRow(history, lastMonth)).not.toContainText("₹5,000.00")
  await expect(monthRow(history, thisMonth)).toContainText("₹8,000.00")
})

test("deleting a ledger that has a budget is refused, and works once the budget is deleted", async ({ session: { page, userId } }) => {
  const day = await today(userId)
  await budget(userId, { ledger: "Groceries", rupees: "5,000", startMonth: monthFrom(day, 0) })

  await page.goto("/nodes")
  const row = page.getByRole("listitem").filter({ has: page.getByText("Groceries", { exact: true }) })
  await row.getByRole("button", { expanded: false }).first().click()
  await row.getByRole("button", { name: "Delete", exact: true }).click()
  await row.getByRole("button", { name: "Confirm delete" }).click()
  await expect(row.getByRole("alert")).toContainText("A budget uses this ledger. Delete the budget, or archive the ledger instead.")
  await expect(row).toBeVisible() // the ledger is still there

  // Delete the budget from its card (behind a confirm), and the ledger can go.
  await openBudgets(page)
  const card = cardOf(page, "Groceries")
  await card.getByRole("button", { name: "Delete Groceries budget", exact: true }).click()
  await card.getByRole("button", { name: "Delete budget Groceries", exact: true }).click()
  await expect(toast(page)).toContainText("Deleted the Groceries budget. Your transactions are untouched.")
  await expect(cardOf(page, "Groceries")).toHaveCount(0)

  await page.goto("/nodes")
  const again = page.getByRole("listitem").filter({ has: page.getByText("Groceries", { exact: true }) })
  await again.getByRole("button", { expanded: false }).first().click()
  await again.getByRole("button", { name: "Delete", exact: true }).click()
  await again.getByRole("button", { name: "Confirm delete" }).click()
  await expect(toast(page)).toContainText("Deleted Groceries")
  await expect(page.getByRole("listitem").filter({ has: page.getByText("Groceries", { exact: true }) })).toHaveCount(0)
})

test("the dashboard says how many budgets need attention only when one is near or over, and leads to the budgets", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "50,000")
  const day = await today(userId)
  const thisMonth = monthFrom(day, 0)
  await budget(userId, { ledger: "Groceries", rupees: "1,000", startMonth: thisMonth })
  await budget(userId, { ledger: "Dining", rupees: "1,000", startMonth: thisMonth })
  const notice = (name: RegExp) => main(page).getByRole("link", { name })

  await page.goto("/")
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible()
  await expect(notice(/budgets? needs? attention/)).toHaveCount(0) // two budgets, nothing spent

  await post(userId, "Bank", "Groceries", "850") // 85%: near
  await page.goto("/")
  await expect(notice(/budgets? needs? attention/)).toHaveCount(1)
  await expect(notice(/^1 budget needs attention$/)).toHaveAttribute("href", "/budgets")

  await post(userId, "Bank", "Dining", "1,200") // over
  await page.goto("/")
  await expect(notice(/^2 budgets need attention$/)).toHaveCount(1)
  await notice(/^2 budgets need attention$/).click()
  await expect(page).toHaveURL(/\/budgets$/)
  await expect(cardOf(page, "Groceries")).toContainText("Near limit")
  await expect(cardOf(page, "Dining")).toContainText("Over budget")
})

test("keyboard: the month picker, a card's actions and the form can all be operated without a mouse", async ({ session: { page, userId } }) => {
  const day = await today(userId)
  const thisMonth = monthFrom(day, 0)
  const lastMonth = monthFrom(day, -1)
  await account(userId, "Bank", "50,000")
  await budget(userId, { ledger: "Groceries", rupees: "1,000", startMonth: lastMonth })
  await budget(userId, { ledger: "Rent", rupees: "20,000", startMonth: lastMonth })
  await openBudgets(page)

  // The month picker: the previous-month link by Enter, then the select by typing its month and the Show button by Enter.
  await main(page).getByRole("link", { name: /^Previous month/ }).focus()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(new RegExp(`month=${monthKey(lastMonth)}$`))
  await expect(main(page).getByRole("heading", { level: 2, name: shortMonth(lastMonth) })).toBeVisible()
  await main(page).getByLabel("Month", { exact: true }).focus()
  await page.keyboard.type(shortMonth(thisMonth).slice(0, 3))
  await expect(main(page).getByLabel("Month", { exact: true })).toHaveValue(monthKey(thisMonth))
  await page.keyboard.press("Tab")
  await expect(main(page).getByRole("button", { name: "Show" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(new RegExp(`month=${monthKey(thisMonth)}$`))
  await expect(main(page).getByRole("heading", { level: 2, name: shortMonth(thisMonth) })).toBeVisible()

  // A card's actions: delete opens its confirm with the safe choice focused, and keeping it returns to the button.
  const card = cardOf(page, "Groceries")
  const remove = card.getByRole("button", { name: "Delete Groceries budget", exact: true })
  await remove.focus()
  await page.keyboard.press("Enter")
  await expect(remove).toHaveAttribute("aria-expanded", "true")
  await expect(card.getByRole("button", { name: "Keep it Groceries budget" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(remove).toHaveAttribute("aria-expanded", "false")
  await expect(remove).toBeFocused()
  await expect(cardOf(page, "Groceries")).toHaveCount(1) // nothing was deleted

  // The history opens by the keyboard, and is itself reachable (it can scroll sideways).
  const past = card.getByRole("button", { name: "Past months for Groceries", exact: true })
  await past.focus()
  await page.keyboard.press("Space")
  await expect(past).toHaveAttribute("aria-expanded", "true")
  await expect(card.getByRole("region", { name: "Past months for Groceries" })).toBeVisible()

  // Edit is a link: Enter follows it.
  await card.getByRole("link", { name: "Edit Groceries budget", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("heading", { level: 1, name: "Edit budget" })).toBeVisible()

  // The form: choose the ledger by typing, Tab to the amount, Enter to save.
  await page.goto("/budgets/new")
  const form = page.getByRole("form", { name: "New budget" })
  await form.getByLabel("Ledger", { exact: true }).focus()
  await page.keyboard.type("Transp")
  await expect(form.getByLabel("Ledger", { exact: true })).toHaveValue(await nodeId(userId, "Transport"))
  await page.keyboard.press("Tab")
  await expect(form.getByLabel("Monthly amount (₹)")).toBeFocused()
  await page.keyboard.type("1,250")
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/budgets\?month=/)
  await expect(toast(page)).toContainText("Created a budget of ₹1,250.00 a month for Transport.")
  await expect(figureOf(cardOf(page, "Transport"), "Budget")).toHaveText("₹1,250.00")
})

test("dark theme and reduced motion: the screen and its form still render, the bar does not animate and the text is light on dark", async ({
  session: { page, userId },
}) => {
  await account(userId, "Bank", "50,000")
  const day = await today(userId)
  await budget(userId, { ledger: "Groceries", rupees: "1,000", startMonth: monthFrom(day, -1) })
  await post(userId, "Bank", "Groceries", "850")
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })

  const channel = (rgb: string) => (rgb.match(/\d+/g) ?? []).slice(0, 3).map(Number)
  await openBudgets(page)
  const card = cardOf(page, "Groceries")
  await expect(card).toBeVisible()
  await expect(card).toContainText("Near limit")
  await expect(card).toContainText("85.0% used")
  expect(channel(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))[0]).toBeLessThan(40)
  expect(channel(await card.getByRole("heading", { name: "Groceries" }).evaluate((el) => getComputedStyle(el).color))[0]).toBeGreaterThan(150)
  // The bar is there at its width, and a reduced-motion visitor gets no transition on it.
  const bar = card.locator("[data-bar]")
  await expect(bar).toHaveAttribute("data-bar", "85")
  expect(await bar.evaluate((el) => getComputedStyle(el).transitionProperty)).toBe("none")
  await openHistory(page, "Groceries")

  await page.goto("/budgets/new")
  await expect(page.getByRole("form", { name: "New budget" })).toBeVisible()
  expect(channel(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))[0]).toBeLessThan(40)

  // And with motion allowed the same bar does animate, so the check above is about the preference and not an absent rule.
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" })
  await openBudgets(page)
  expect(await cardOf(page, "Groceries").locator("[data-bar]").evaluate((el) => getComputedStyle(el).transitionProperty)).toContain("width")
})
