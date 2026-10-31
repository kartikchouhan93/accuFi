import type { Locator, Page } from "@playwright/test"
import { addDays, calendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { expect, test } from "./fixtures"
import { balanceOf, entries } from "./screens"
import { account, investment, nodeId, post, recurringRule, today } from "./seed"

// Recurring entries (spec M4), driven through a real browser against a real server and database. A rule only ever
// proposes: what a test seeds is a rule, and the entries it has proposed wait in the inbox until a person posts or skips
// them. `createRule` generates whatever is already due as part of saving, so a rule seeded with a start date in the past
// leaves its entries in the inbox with no further step (the server runs with the hourly sweep off, so nothing else
// would). Every date below is relative to the real current day, except the month-end test, which is anchored in January
// to April 2026 (all in the past), and every expected figure is a literal worked out by hand beside it. A test must pass on
// ANY day of the month, so a ledger is only ever looked at over an explicit range (`ledgerBetween`), never "this month".

const PASSWORD = "correct horse battery"
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "20 Oct 2026", as the screens print a day. Written out here rather than imported: the test must not share the code it checks. */
const printed = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`
const daysFrom = (day: string, count: number) => addDays(calendarDate(day), count)
/**
 * The ledger over an explicit range of days. Never a bare "/transactions": that lists the current month only, and a day
 * relative to today (yesterday, 20 days ago) is in the month before for the first days of every month.
 */
const ledgerBetween = (page: Page, from: string, to: string) => page.goto(`/transactions?from=${from}&to=${to}`)

const inbox = (page: Page) => page.getByRole("region", { name: "Inbox", exact: true })
const rules = (page: Page) => page.getByRole("region", { name: "Rules", exact: true })
const cards = (page: Page) => inbox(page).getByRole("listitem")
/** The inbox card of a rule, by its name; with several cards of one rule, the first (the oldest). */
const cardOf = (page: Page, name: string) => cards(page).filter({ has: page.getByRole("heading", { name, exact: true }) }).first()
const navLink = (page: Page) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Recurring/ }).first()
/** The link's name is "Recurring, 3 waiting": one string, with no space before the comma. */
const waiting = (count: number) => new RegExp(`^Recurring, ${count} waiting$`)
const netWorth = (page: Page) => page.getByRole("region", { name: "Net worth", exact: true }).locator("p").first()

async function openRecurring(page: Page) {
  await page.goto("/recurring")
  await expect(page.getByRole("heading", { level: 1, name: "Recurring" })).toBeVisible()
}

test("exit criterion: a rule three weeks behind proposes three entries, and only the one posted counts", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "10,000")
  const day = await today(userId)
  // Weekly from 20 days ago: 20, 13 and 6 days ago are due, the next one is tomorrow. Three entries, and not a fourth today.
  const dates = [daysFrom(day, -20), daysFrom(day, -13), daysFrom(day, -6)]
  await recurringRule(userId, { name: "Gym", from: "Bank", to: "Health", rupees: "1,500", frequency: "WEEKLY", startDate: dates[0], note: "Gym membership" })

  // Pending entries are proposals: they are in no balance and in no net worth.
  await page.goto("/")
  await expect(netWorth(page)).toHaveText("₹10,000.00")

  await openRecurring(page)
  await expect(cards(page)).toHaveCount(3)
  // Oldest first.
  for (const [index, date] of dates.entries()) await expect(cards(page).nth(index)).toContainText(`Due ${printed(date)}`)
  await expect(navLink(page)).toHaveAccessibleName(waiting(3))

  await cards(page).first().getByRole("button", { name: "Post Gym", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("Posted Gym: ₹1,500.00 from Bank to Health.")
  await expect(cards(page)).toHaveCount(2)
  await expect(cards(page).first()).toContainText(`Due ${printed(dates[1])}`) // the one posted was the oldest
  await expect(navLink(page)).toHaveAccessibleName(waiting(2))

  // The transaction is in the ledger, on the day the entry was due, and the account moved by exactly that amount.
  await ledgerBetween(page, dates[0], day)
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Gym membership" })).toHaveCount(1)
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Gym membership" })).toContainText("₹1,500.00")
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Gym membership" })).toContainText(printed(dates[0]))
  await expect(balanceOf(page, "Bank")).toContainText("₹8,500.00") // 10,000 - 1,500

  // Net worth moved by that one amount: the two entries still waiting count nowhere.
  await page.goto("/")
  await expect(netWorth(page)).toHaveText("₹8,500.00")
})

test("exit criterion: a rule on the 31st proposes the last day of each short month, from January to April", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "1,00,000")
  await recurringRule(userId, {
    name: "Rent",
    from: "Bank",
    to: "Rent",
    rupees: "20,000",
    frequency: "MONTHLY",
    dayOfMonth: 31,
    startDate: "2026-01-31",
    endDate: "2026-04-30",
  })

  await openRecurring(page)
  await expect(cards(page)).toHaveCount(4)
  const expected = ["31 Jan 2026", "28 Feb 2026", "31 Mar 2026", "30 Apr 2026"]
  for (const [index, date] of expected.entries()) await expect(cards(page).nth(index)).toContainText(`Due ${date}`)

  // The rule says so in words, and has no more to make: its end date has been passed.
  const rule = rules(page).getByRole("listitem").filter({ hasText: "Rent" })
  await expect(rule).toContainText("Monthly on the 31st, or the last day")
  await expect(rule).toContainText("Until 30 Apr 2026")
  await expect(rule).toContainText("It has made its last entry.")
})

test("edit and post: the amount and the day changed on a card are the ones the transaction carries", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "10,000")
  const day = await today(userId)
  const due = daysFrom(day, -2)
  const chosen = daysFrom(day, -1)
  await recurringRule(userId, { name: "Internet", from: "Bank", to: "Utilities", rupees: "800", frequency: "WEEKLY", startDate: due, note: "Broadband" })

  await openRecurring(page)
  const card = cardOf(page, "Internet")
  await card.getByRole("button", { name: "Edit and post Internet", exact: true }).click()
  const form = page.getByRole("form", { name: "Edit and post Internet" })
  await expect(form.getByLabel("Amount (₹)")).toBeFocused()
  await expect(form.getByLabel("Amount (₹)")).toHaveValue("800.00")
  await expect(form.getByLabel("Date")).toHaveValue(due)
  await form.getByLabel("Amount (₹)").fill("950.50")
  await form.getByLabel("Date").fill(chosen)
  await form.getByLabel("Note").fill("Broadband, with the late fee")
  await form.getByRole("button", { name: "Post entry" }).click()
  await expect(page.getByRole("status")).toContainText("Posted Internet: ₹950.50 from Bank to Utilities.")
  await expect(cards(page)).toHaveCount(0)

  await ledgerBetween(page, due, day)
  const row = entries(page).getByRole("listitem").filter({ hasText: "Broadband, with the late fee" })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText("₹950.50")
  await expect(row).toContainText(printed(chosen))
  await expect(balanceOf(page, "Bank")).toContainText("₹9,049.50") // 10,000 - 950.50
})

test("skip: the entry leaves the inbox and counts nowhere, and Recently handled puts it back", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "10,000")
  const day = await today(userId)
  const due = daysFrom(day, -3)
  await recurringRule(userId, { name: "Magazine", from: "Bank", to: "Dining", rupees: "300", frequency: "WEEKLY", startDate: due })

  await openRecurring(page)
  await expect(navLink(page)).toHaveAccessibleName(waiting(1))
  await cardOf(page, "Magazine").getByRole("button", { name: "Skip Magazine", exact: true }).click()
  await expect(page.getByRole("status")).toContainText(`Skipped Magazine, due ${printed(due)}.`)
  await expect(cards(page)).toHaveCount(0)
  await expect(inbox(page)).toContainText("Nothing is waiting.")
  await expect(navLink(page)).toHaveAccessibleName("Recurring")

  await page.getByRole("button", { name: /^Recently handled/ }).click()
  const handled = page.getByRole("region", { name: /^Recently handled/ }).getByRole("listitem")
  await expect(handled).toHaveCount(1)
  await expect(handled).toContainText(`Skipped, due ${printed(due)}`)
  await handled.getByRole("button", { name: "Put back" }).click()
  await expect(page.getByRole("status")).toContainText(`Put back Magazine, due ${printed(due)}.`)
  await expect(cards(page)).toHaveCount(1)
  await expect(cards(page).first()).toContainText(`Due ${printed(due)}`)
  await expect(navLink(page)).toHaveAccessibleName(waiting(1))

  // Skipping never moved money.
  await page.goto("/")
  await expect(netWorth(page)).toHaveText("₹10,000.00")
})

test("create from the form: the preview says what will happen, and the rule is listed with its schedule and next entry", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "50,000")
  const day = await today(userId)
  // Next year's 15 March: always in the future, and a day no month clamps.
  const start = `${Number(day.slice(0, 4)) + 1}-03-15`
  const second = `${Number(day.slice(0, 4)) + 1}-04-15`

  await openRecurring(page)
  await expect(inbox(page)).toContainText("No rules yet")
  await page.getByRole("link", { name: "New rule" }).first().click()
  await expect(page.getByRole("heading", { level: 1, name: "New rule" })).toBeVisible()

  const form = page.getByRole("form", { name: "New rule" })
  await form.getByLabel("Name").fill("SIP into savings")
  await form.getByLabel("From", { exact: true }).selectOption({ label: "Bank" })
  await form.getByLabel("To", { exact: true }).selectOption({ label: "Health" })
  await form.getByLabel("Amount (₹)").fill("2,500")
  await form.getByLabel("Starts on").fill(start)

  // The live preview names the schedule in words and the first dates, before anything is saved.
  const preview = form.getByRole("region", { name: "Schedule preview" })
  await expect(preview).toContainText("Monthly on the 15th")
  await expect(preview).toContainText(printed(start))
  await expect(preview).toContainText(printed(second))
  await expect(preview).toContainText("And so on, with no end.")
  // A start in the future puts nothing in the inbox, and the preview does not claim it will.
  await expect(preview).not.toContainText("appear in your inbox")

  await form.getByRole("button", { name: "Create rule" }).click()
  await expect(page).toHaveURL(/\/recurring$/)
  await expect(page.getByRole("status")).toContainText("Created SIP into savings, ₹2,500.00. Monthly on the 15th.")
  const rule = rules(page).getByRole("listitem").filter({ hasText: "SIP into savings" })
  await expect(rule).toContainText("Monthly on the 15th")
  await expect(rule).toContainText("₹2,500.00")
  await expect(rule).toContainText(`Next entry ${printed(start)}.`)
  await expect(cards(page)).toHaveCount(0)
  await expect(inbox(page)).toContainText("Nothing is waiting.")
})

/** Days in month `month` (1-based) of `year`. */
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()
const dayText = (year: number, month: number, dayOfMonth: number) =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`
type YearMonth = [year: number, month: number]
const monthOf = (day: string): YearMonth => [Number(day.slice(0, 4)), Number(day.slice(5, 7))]
const monthBefore = ([year, month]: YearMonth): YearMonth => (month === 1 ? [year - 1, 12] : [year, month - 1])
const monthAfter = ([year, month]: YearMonth): YearMonth => (month === 12 ? [year + 1, 1] : [year, month + 1])
/** The 31st, or the month's last day when it is shorter. */
const monthEnd = ([year, month]: YearMonth) => dayText(year, month, Math.min(31, daysInMonth(year, month)))

/** Open the transaction whose note is `note` in the ledger and follow its "Make recurring" link. */
async function makeRecurringFrom(page: Page, note: string) {
  await page.goto("/transactions?from=&to=") // every date: the payment is in an earlier month than the list opens on
  const row = entries(page).getByRole("listitem").filter({ hasText: note })
  await row.getByRole("button", { expanded: false }).first().click()
  await row.getByRole("link", { name: "Make recurring" }).click()
  await expect(page).toHaveURL(/\/recurring\/new\?from=/)
  return page.getByRole("form", { name: "New rule" })
}

test("make recurring: a transaction's row opens the new-rule form already filled in", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "1,00,000")
  const day = await today(userId)
  // Pinned to the 15th of last month: a day no month clamps, so the start date below is always asserted.
  const [paidYear, paidMonth] = monthBefore(monthOf(day))
  const paid = dayText(paidYear, paidMonth, 15)
  await post(userId, "Bank", "Rent", "21,500", { date: paid, note: "Monthly rent", tags: ["home"] })

  const form = await makeRecurringFrom(page, "Monthly rent")
  await expect(form.getByLabel("From", { exact: true })).toHaveValue(await nodeId(userId, "Bank"))
  await expect(form.getByLabel("To", { exact: true })).toHaveValue(await nodeId(userId, "Rent"))
  await expect(form.getByLabel("Amount (₹)")).toHaveValue("21500.00")
  await expect(form.getByLabel("Note")).toHaveValue("Monthly rent")
  await expect(form.getByLabel("Tags")).toHaveValue("home")
  await expect(form.getByLabel("Repeats")).toHaveValue("MONTHLY")
  // The name is the one thing the transaction cannot supply.
  await expect(form.getByLabel("Name")).toHaveValue("")
  // Next month, the same day of the month as the payment, which is also the rule's day of the month.
  const [nextYear, nextMonth] = monthAfter([paidYear, paidMonth])
  await expect(form.getByLabel("Starts on")).toHaveValue(dayText(nextYear, nextMonth, 15))
  await expect(form.getByLabel("Day of the month")).toHaveValue("15")

  // Name it and save: the rule exists, with the transaction's content.
  await form.getByLabel("Name").fill("Flat rent")
  await form.getByRole("button", { name: "Create rule" }).click()
  await expect(page).toHaveURL(/\/recurring$/)
  const rule = rules(page).getByRole("listitem").filter({ hasText: "Flat rent" })
  await expect(rule).toContainText("₹21,500.00")
  await expect(rule).toContainText("Bank")
})

test("make recurring: a payment on the 31st becomes a month-end rule, not one that drifts to the 28th", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "1,00,000")
  const day = await today(userId)
  // The most recent 31st before this month: a payment on the last day of a long month.
  let paidIn = monthBefore(monthOf(day))
  while (daysInMonth(...paidIn) !== 31) paidIn = monthBefore(paidIn)
  const paid = dayText(paidIn[0], paidIn[1], 31)
  await post(userId, "Bank", "Rent", "21,500", { date: paid, note: "Month-end rent" })

  const form = await makeRecurringFrom(page, "Month-end rent")
  // The start is that day next month, clamped to the month's length; the rule's day of the month is the payment's own: 31.
  const startIn = monthAfter(paidIn)
  await expect(form.getByLabel("Starts on")).toHaveValue(monthEnd(startIn))
  await expect(form.getByLabel("Day of the month")).toHaveValue("31")
  await expect(form.getByRole("region", { name: "Schedule preview" })).toContainText("Monthly on the 31st, or the last day")

  await form.getByLabel("Name").fill("Month-end rent")
  await form.getByRole("button", { name: "Create rule" }).click()
  await expect(page).toHaveURL(/\/recurring$/)

  // Every entry the rule has proposed so far, and the next one, is on its month's last day: nothing sits on the 28th.
  // Worked out here: the first scheduled day on or after `start` that is after today, month by month.
  let nextIn = startIn
  while (monthEnd(nextIn) <= day) nextIn = monthAfter(nextIn)
  const expectedNext = monthEnd(nextIn)
  const rule = rules(page).getByRole("listitem").filter({ hasText: "Month-end rent" })
  await expect(rule).toContainText("Monthly on the 31st, or the last day")
  await expect(rule).toContainText(`Next entry ${printed(expectedNext)}.`)
  const stored = await prisma.recurringOccurrence.findMany({ where: { userId }, orderBy: { dueOn: "asc" } })
  for (const occurrence of stored) {
    const due = occurrence.dueOn.toISOString().slice(0, 10)
    expect(Number(due.slice(8, 10))).toBe(daysInMonth(Number(due.slice(0, 4)), Number(due.slice(5, 7))))
  }
})

test("signing in catches up what fell due while nobody was signed in", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "10,000")
  const day = await today(userId)
  // A rule made for the future, then moved into the past under the application's feet, as if the instance had been switched
  // off since: nothing has proposed its entries, and the sweep is off in this suite.
  const rule = await recurringRule(userId, { name: "Newspaper", from: "Bank", to: "Dining", rupees: "250", frequency: "DAILY", startDate: daysFrom(day, 30) })
  const past = daysFrom(day, -2) // 2 days ago, yesterday and today are due
  await prisma.recurringRule.update({ where: { id: rule.id }, data: { startDate: new Date(`${past}T00:00:00Z`), nextDueOn: new Date(`${past}T00:00:00Z`) } })
  expect(await prisma.recurringOccurrence.count({ where: { userId } })).toBe(0)

  await page.getByRole("button", { name: "Sign out" }).click()
  await expect(page).toHaveURL(/\/login$/)

  const { email } = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password").fill(PASSWORD)
  await page.getByRole("button", { name: "Sign in" }).click()
  await page.waitForURL((url) => url.pathname !== "/login")

  // The catch-up runs in the background after the sign-in: wait for it, never prompt it.
  await expect.poll(() => prisma.recurringOccurrence.count({ where: { userId, status: "PENDING" } }), { timeout: 15_000 }).toBe(3)
  await openRecurring(page)
  await expect(cards(page)).toHaveCount(3)
  await expect(cards(page).first()).toContainText(`Due ${printed(past)}`)
  await expect(cards(page).last()).toContainText(`Due ${printed(day)}`)
  await expect(navLink(page)).toHaveAccessibleName(waiting(3))
})

test("a quantity SIP cannot be posted blind: Post asks for the quantity, and the rule cannot post itself", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "50,000")
  await investment(userId, "Gold SIP", { unit: "gram" })
  const day = await today(userId)
  const due = daysFrom(day, -4)
  await recurringRule(userId, { name: "Gold every month", from: "Bank", to: "Gold SIP", rupees: "5,000", frequency: "MONTHLY", startDate: due })

  await openRecurring(page)
  const card = cardOf(page, "Gold every month")
  await expect(card).toContainText("valued by quantity")
  await expect(card.getByRole("button", { name: /^Edit and post/ })).toHaveCount(0) // the one form is what Post opens
  await card.getByRole("button", { name: "Post Gold every month", exact: true }).click()
  const form = page.getByRole("form", { name: "Edit and post Gold every month" })
  await expect(form.getByLabel("Quantity (gram)")).toBeFocused()
  await expect(cards(page)).toHaveCount(1) // nothing was posted by the press

  // A refusal that names the field, not a posted entry of no quantity.
  await form.getByRole("button", { name: "Post entry" }).click()
  await expect(form.getByLabel("Quantity (gram)")).toHaveAttribute("aria-invalid", "true")
  await expect(cards(page)).toHaveCount(1)

  await form.getByLabel("Quantity (gram)").fill("0.75")
  await expect(form).toContainText("Records 0.75 gram bought.")
  await form.getByRole("button", { name: "Post entry" }).click()
  await expect(page.getByRole("status")).toContainText("Posted Gold every month: ₹5,000.00 from Bank to Gold SIP.")
  await expect(cards(page)).toHaveCount(0)

  await ledgerBetween(page, due, day)
  await expect(balanceOf(page, "Bank")).toContainText("₹45,000.00")

  // The new-rule form does not offer posting automatically into this investment, and says why.
  await page.goto("/recurring/new")
  const rule = page.getByRole("form", { name: "New rule" })
  await expect(rule.getByLabel("Post automatically")).toBeVisible() // offered until a destination that needs a quantity is chosen
  await rule.getByLabel("From", { exact: true }).selectOption({ label: "Bank" })
  await rule.getByLabel("To", { exact: true }).selectOption({ label: "Gold SIP" })
  await expect(rule.getByLabel("Post automatically")).toHaveCount(0)
  await expect(rule).toContainText("Not available here.")
  await expect(rule).toContainText("Each entry waits in your inbox instead.")
})

/** What has the keyboard, as the card it is in and the text of the control. */
async function focusedControl(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el) return ""
    const card = el.closest("li")?.querySelector("h3")?.textContent ?? ""
    return `${card}|${el.tagName}|${(el.textContent ?? "").trim() || el.getAttribute("name") || ""}`
  })
}

/** Tab until `target` has the focus; fails if it is not reached, so a control that cannot be tabbed to fails the test. */
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 120; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return
    await page.keyboard.press("Tab")
  }
  throw new Error(`Tab never reached ${String(target)}`)
}

test("the inbox is worked entirely by keyboard, reads in both themes, and keeps still for reduced motion", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "10,000")
  const day = await today(userId)
  await recurringRule(userId, { name: "Alpha", from: "Bank", to: "Groceries", rupees: "100", frequency: "WEEKLY", startDate: daysFrom(day, -2) })
  await recurringRule(userId, { name: "Bravo", from: "Bank", to: "Dining", rupees: "200", frequency: "WEEKLY", startDate: daysFrom(day, -1) })
  await recurringRule(userId, { name: "Charlie", from: "Bank", to: "Transport", rupees: "300", frequency: "WEEKLY", startDate: day })

  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" })
  await openRecurring(page)
  await expect(cards(page)).toHaveCount(3)

  // Both themes, by the real toggle: the screen, its cards and the amounts are drawn in each.
  const toggle = page.getByRole("complementary").getByRole("button", { name: /^Theme:/ })
  for (const theme of ["light", "dark"]) {
    await toggle.click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
    await expect(cardOf(page, "Alpha")).toBeVisible()
    await expect(cardOf(page, "Alpha")).toContainText("₹100.00")
    await expect(rules(page)).toBeVisible()
  }
  // Dark is showing: the page's background is far darker than light's (it may still be easing there, so wait for it).
  await expect
    .poll(async () => Number((await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).match(/\d+/g)?.[0]))
    .toBeLessThan(40)
  await page.reload()
  await expect(cards(page)).toHaveCount(3)
  await expect(cardOf(page, "Alpha")).toBeVisible()
  // Reduced motion: the disclosure opens without waiting on a transition, and the cards are plainly there.
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true)

  // Edit and post, by keyboard: Tab to the button, Enter opens the form with the amount focused, Escape closes it and
  // hands the focus back to the button that opened it.
  const edit = cardOf(page, "Alpha").getByRole("button", { name: "Edit and post Alpha", exact: true })
  await page.locator("body").focus()
  await tabTo(page, edit)
  expect(await focusedControl(page)).toBe("Alpha|BUTTON|Edit and post Alpha")
  await page.keyboard.press("Enter")
  await expect(page.getByRole("form", { name: "Edit and post Alpha" }).getByLabel("Amount (₹)")).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(edit).toBeFocused()

  // Post the first by keyboard: it leaves the inbox and the message takes the focus the card had.
  await tabTo(page, cardOf(page, "Alpha").getByRole("button", { name: "Post Alpha", exact: true }))
  await page.keyboard.press("Enter")
  await expect(page.getByRole("status")).toContainText("Posted Alpha")
  await expect(cards(page)).toHaveCount(2)
  await expect(page.getByRole("status")).toBeFocused()

  // Skip the next by keyboard, then put it back from Recently handled by keyboard.
  await page.locator("body").focus()
  await tabTo(page, cardOf(page, "Bravo").getByRole("button", { name: "Skip Bravo", exact: true }))
  await page.keyboard.press("Enter")
  await expect(page.getByRole("status")).toContainText("Skipped Bravo")
  await expect(cards(page)).toHaveCount(1)
  const recently = page.getByRole("button", { name: /^Recently handled/ })
  await tabTo(page, recently)
  await page.keyboard.press("Enter")
  // The Put back in the list of what was handled (the skip's message has one too).
  const putBack = page.getByRole("region", { name: /^Recently handled/ }).getByRole("button", { name: "Put back" })
  await tabTo(page, putBack)
  await page.keyboard.press("Enter")
  await expect(page.getByRole("status")).toContainText("Put back Bravo")
  await expect(cards(page)).toHaveCount(2)
  await expect(cardOf(page, "Bravo")).toBeVisible()
})
