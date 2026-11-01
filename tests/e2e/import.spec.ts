import type { Page } from "@playwright/test"
import { addDays, calendarDate } from "@/domain/calendar-date"
import { expect, openRow, test } from "./fixtures"
import { bankSignedColumnCsv, bankSplitColumnsCsv, cardCsv, cardRow, row, safeAnchor, signedRow, splitRow } from "./fixtures-import"
import { balanceOf, entries } from "./screens"
import { account, addExpense, card, incomeSource, nodeId, post, recurringRule, today } from "./seed"

// The CSV import feature (plan M6), driven through a real browser against a real server and database. An import never
// writes until Commit: upload, map, stage and review are all read-only until that one step, so the exit criterion below
// proves the whole chain by seeding one real, hand-entered transaction first and checking it is still there, untouched,
// once the imported ones have come and gone (committed, then reversed). Every date is derived from `today` and a file's
// own offsets, never a literal, so the suite passes on any day it runs; a month-end edge is exercised deliberately where
// named (the ambiguous-date and bad-date rows), never by accident.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
/** "20 Oct 2026", as the screens print a day. Written out here rather than imported: the test must not share the code it checks. */
const printed = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`

/** The ledger over an explicit range of days: never a bare "/transactions", which lists the current month only. */
const ledgerBetween = (page: Page, from: string, to: string) => page.goto(`/transactions?from=${from}&to=${to}`)

const stagedRows = (page: Page) => page.getByRole("list", { name: "Staged rows" }).getByRole("listitem")
/** A staged row's card, by text that appears nowhere else on the page (its description, or its raw cells for an errored one). */
const rowWith = (page: Page, text: string) => stagedRows(page).filter({ hasText: text })
/** One figure of the batch page's summary, by its label (`<dt>Imported</dt><dd>4</dd>`, as one pair). */
const statOf = (page: Page, label: string) => page.locator("dl > div").filter({ hasText: label }).locator("dd")

/** Upload `content` as `fileName` onto the account named `accountLabel`, through the real form; ends on the map screen. */
async function uploadFile(page: Page, accountLabel: string, fileName: string, content: string) {
  await page.goto("/import/new")
  await page.getByLabel("Account").selectOption({ label: accountLabel })
  await page.getByLabel("Statement file").setInputFiles({ name: fileName, mimeType: "text/csv", buffer: Buffer.from(content, "utf-8") })
  await page.getByRole("button", { name: "Upload" }).click()
  await page.waitForURL(/\/import\/[^/]+\/map$/)
}

/** Choose the mapping controls given, by their real selects, and submit (a plain navigation: "Update preview"). */
async function setMapping(
  page: Page,
  fields: { dateFormat?: string; dateCol?: string; descCol?: string; amountCol?: string; debitCol?: string; creditCol?: string; sign?: string },
) {
  if (fields.dateFormat) await page.getByLabel("Date format").selectOption(fields.dateFormat)
  if (fields.sign) await page.getByLabel("Positive amounts mean").selectOption({ label: fields.sign })
  if (fields.dateCol) await page.getByLabel("Date column").selectOption({ label: fields.dateCol })
  if (fields.descCol) await page.getByLabel("Description column").selectOption({ label: fields.descCol })
  if (fields.amountCol) await page.getByLabel("Amount column").selectOption({ label: fields.amountCol })
  if (fields.debitCol) await page.getByLabel("Debit column").selectOption({ label: fields.debitCol })
  if (fields.creditCol) await page.getByLabel("Credit column").selectOption({ label: fields.creditCol })
  await page.getByRole("button", { name: "Update preview" }).click()
}

/** Stage the batch the map screen is on; `confirmRepeat` checks the repeat-upload box first. `force` because the
 * button is `aria-disabled`, never `disabled`, while an earlier upload is unconfirmed: a real visitor can still press
 * it (that is how the inline "confirm below" message is reached), but Playwright's own actionability check treats
 * `aria-disabled` as not-enabled and would otherwise wait out the whole test for it to clear. */
async function stageRows(page: Page, opts: { confirmRepeat?: boolean } = {}) {
  if (opts.confirmRepeat) await page.getByRole("checkbox", { name: /uploaded before, and want to stage it again anyway/ }).check()
  await page.getByRole("button", { name: "Stage rows" }).click({ force: true })
}

test("exit criterion: upload, map, review, commit and reverse a statement, around a hand-entered transaction that survives all of it", async ({
  session: { page, userId },
}) => {
  test.setTimeout(90_000)
  await account(userId, "Checking", "50,000")
  await incomeSource(userId, "Freelance Clients")
  const day = await today(userId)
  // The account's balance (shown on the Transactions screen) is read as of today: every date below sits a few days in
  // the PAST, so the committed rows have already happened by the time the balance is read, not still waiting for a
  // future day to arrive.
  const anchor = addDays(safeAnchor(day), -5)

  // The hand-entered transaction: ₹500.00 out of Checking to Groceries, 2 days before the statement's matching row.
  await post(userId, "Checking", "Groceries", "500", { date: addDays(anchor, -2), note: "Weekly grocery run" })
  await page.goto("/")
  await expect(page.getByRole("region", { name: "Net worth", exact: true }).locator("p").first()).toHaveText("₹49,500.00")

  // A 6-row debit/credit statement: a row that repeats the hand-entered one, a row with a date that cannot exist, two
  // rows sharing a description (for the "apply to similar" bulk action), an incoming row, and one more outgoing row.
  const content = bankSplitColumnsCsv([
    splitRow(anchor, 0, "Grocery Mart", "500.00", "DEBIT"),
    row(["31/02/99", "Bad Row", "50.00", ""]),
    splitRow(anchor, 1, "Coffee Shop", "120.00", "DEBIT"),
    splitRow(anchor, 2, "Coffee Shop", "95.50", "DEBIT"),
    splitRow(anchor, 1, "Freelance Payment", "300.00", "CREDIT"),
    splitRow(anchor, 3, "Electric Bill", "220.25", "DEBIT"),
  ])
  await uploadFile(page, "Checking", "checking-statement.csv", content)

  // The explicit date format: the file is DD/MM/YY, not the map screen's own default of DD/MM/YYYY.
  await setMapping(page, { dateFormat: "DD/MM/YY", dateCol: "Date", descCol: "Description", debitCol: "Debit", creditCol: "Credit" })
  const preview = page.getByRole("region", { name: "Preview of the first 20 rows, as they will be recorded" })
  await expect(preview).toContainText("Grocery Mart")
  await expect(preview).toContainText("The date column is not a valid DD/MM/YY date")
  await stageRows(page)
  await page.waitForURL(/\/review$/)

  // The matching row is flagged, with the hand-entered transaction right beside it.
  const duplicate = rowWith(page, "Grocery Mart").getByRole("group", { name: "Possible duplicate" })
  await expect(duplicate).toContainText("This looks like it repeats an existing transaction.")
  await expect(duplicate).toContainText(printed(addDays(anchor, -2)))
  await expect(duplicate).toContainText("₹500.00")
  await expect(duplicate).toContainText("Groceries")
  await expect(duplicate).toContainText("Weekly grocery run")

  // The bad-date row is errored, with its own reason and nothing to decide.
  const errored = rowWith(page, "Bad Row")
  await expect(errored.getByRole("alert")).toContainText("The date column is not a valid DD/MM/YY date")

  // Counterparts: one bulk "apply to similar" for the two Coffee Shop rows, then Import on each; a plain pick-and-Import
  // for the incoming and the last outgoing row. "Import anyway" is never used; the flagged row is skipped instead.
  const coffee1 = rowWith(page, "Coffee Shop").filter({ hasText: "₹120.00" })
  await coffee1.getByLabel("Counterpart ledger").selectOption(await nodeId(userId, "Dining"))
  await coffee1.getByRole("button", { name: "Use this ledger for every row that reads the same" }).click()
  await expect(page.getByRole("status")).toContainText("Set this ledger on 2 rows that read the same.")
  await rowWith(page, "Coffee Shop").filter({ hasText: "₹120.00" }).getByRole("button", { name: "Import", exact: false }).click()
  await expect(page.getByRole("status")).toContainText("ready to import")
  await rowWith(page, "Coffee Shop").filter({ hasText: "₹95.50" }).getByRole("button", { name: "Import", exact: false }).click()
  await expect(page.getByRole("status")).toContainText("ready to import")

  const freelance = rowWith(page, "Freelance Payment")
  await freelance.getByLabel("Counterpart ledger").selectOption(await nodeId(userId, "Freelance Clients"))
  await freelance.getByRole("button", { name: "Import", exact: false }).click()
  await expect(page.getByRole("status")).toContainText("ready to import")

  const electric = rowWith(page, "Electric Bill")
  await electric.getByLabel("Counterpart ledger").selectOption(await nodeId(userId, "Utilities"))
  await electric.getByRole("button", { name: "Import", exact: false }).click()
  await expect(page.getByRole("status")).toContainText("ready to import")

  // The flagged row: Skip as duplicate, never Import anyway.
  await rowWith(page, "Grocery Mart").getByRole("button", { name: "Skip as duplicate" }).click()
  await expect(page.getByRole("status")).toContainText("will be skipped as a duplicate")

  await expect(page.getByRole("button", { name: "Commit", exact: true })).not.toHaveAttribute("aria-disabled", "true")
  await page.getByRole("button", { name: "Commit", exact: true }).click()
  await page.waitForURL(/\/batch$/)

  // The batch page's own totals: 4 imported, 1 skipped (the duplicate), 0 linked, 1 errored, ₹300.00 in and ₹435.75 out
  // (120.00 + 95.50 + 220.25).
  await expect(page.getByRole("heading", { level: 1 })).toContainText("checking-statement.csv")
  await expect(statOf(page, "Imported")).toHaveText("4")
  await expect(statOf(page, "Skipped")).toHaveText("1")
  await expect(statOf(page, "Linked to recurring")).toHaveText("0")
  await expect(statOf(page, "Errored")).toHaveText("1")
  await expect(statOf(page, "Total in")).toContainText("₹300.00")
  await expect(statOf(page, "Total out")).toContainText("₹435.75")
  await expect(statOf(page, "Date range")).toContainText(printed(addDays(anchor, 1)))
  await expect(statOf(page, "Date range")).toContainText(printed(addDays(anchor, 3)))
  const batchUrl = page.url()

  // The account moved by exactly the net (-120 - 95.50 + 300 - 220.25 = -135.75), from ₹49,500.00 to ₹49,364.25; the
  // imported rows are in the ledger with their exact amounts and dates, and the hand-entered one is untouched.
  await ledgerBetween(page, addDays(anchor, -10), addDays(anchor, 10))
  await expect(balanceOf(page, "Checking")).toContainText("₹49,364.25")
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Weekly grocery run" })).toContainText("₹500.00")
  const coffeeEntries = entries(page).getByRole("listitem").filter({ hasText: "Coffee Shop" })
  await expect(coffeeEntries).toHaveCount(2)
  await expect(coffeeEntries.filter({ hasText: "₹120.00" })).toContainText(printed(addDays(anchor, 1)))
  await expect(coffeeEntries.filter({ hasText: "₹95.50" })).toContainText(printed(addDays(anchor, 2)))
  const electricEntry = entries(page).getByRole("listitem").filter({ hasText: "Electric Bill" })
  await expect(electricEntry).toContainText("₹220.25")
  await expect(electricEntry).toContainText(printed(addDays(anchor, 3)))
  const freelanceEntry = entries(page).getByRole("listitem").filter({ hasText: "Freelance Payment" })
  await expect(freelanceEntry).toContainText("₹300.00")

  // Reverse: the confirm names exactly what goes, and the balance returns to its exact earlier value.
  await page.goto(batchUrl)
  await page.getByRole("button", { name: "Reverse this import" }).click()
  await expect(page.getByRole("group", { name: "Reverse the checking-statement.csv import?" })).toContainText(
    "Reversing deletes the 4 transactions this import created and returns 0 linked recurring entries to pending.",
  )
  await page.getByRole("button", { name: "Reverse import" }).click()
  await expect(page.getByRole("status")).toContainText("Reversed. 4 transactions deleted.")
  await expect(page.getByRole("button", { name: "Reverse this import" })).toHaveCount(0)

  await ledgerBetween(page, addDays(anchor, -10), addDays(anchor, 10))
  await expect(balanceOf(page, "Checking")).toContainText("₹49,500.00")
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Weekly grocery run" })).toHaveCount(1)
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Coffee Shop" })).toHaveCount(0)
})

test("re-uploading the same file warns and needs confirmation before it can be staged", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "10,000")
  const anchor = safeAnchor(await today(userId))
  const content = bankSignedColumnCsv([signedRow(anchor, 0, "Coffee", "100.00")])

  await uploadFile(page, "Bank", "repeat.csv", content)
  const firstUrl = page.url()

  await uploadFile(page, "Bank", "repeat.csv", content)
  await expect(page.getByRole("alert").filter({ hasText: "uploaded before" })).toContainText("now uploaded")
  await expect(page.getByText("Staging it again may record the same entries twice.")).toBeVisible()

  await setMapping(page, { dateFormat: "DD-MMM-YYYY", dateCol: "Date", descCol: "Description", amountCol: "Amount" })
  await stageRows(page)
  await expect(page.getByRole("region", { name: "Stage rows" }).getByRole("alert")).toContainText(
    "Confirm the repeat upload below before staging this import.",
  )
  await expect(page).toHaveURL(/\/map(\?|$)/)

  await stageRows(page, { confirmRepeat: true })
  await page.waitForURL(/\/review$/)
  expect(page.url()).not.toBe(firstUrl)
})

test("a shifted, overlapping file flags its repeating row as a duplicate of the first import's own transaction", async ({
  session: { page, userId },
}) => {
  test.setTimeout(60_000)
  await account(userId, "Bank", "20,000")
  const anchor = safeAnchor(await today(userId))

  // The first statement: one row, imported for real.
  await uploadFile(page, "Bank", "first.csv", bankSignedColumnCsv([signedRow(anchor, 0, "Phone Bill", "499.00", "-")]))
  await setMapping(page, { dateFormat: "DD-MMM-YYYY", dateCol: "Date", descCol: "Description", amountCol: "Amount" })
  await stageRows(page)
  await page.waitForURL(/\/review$/)
  await rowWith(page, "Phone Bill").getByLabel("Counterpart ledger").selectOption(await nodeId(userId, "Utilities"))
  await rowWith(page, "Phone Bill").getByRole("button", { name: "Import", exact: false }).click()
  await expect(page.getByRole("status")).toContainText("ready to import")
  await page.getByRole("button", { name: "Commit", exact: true }).click()
  await page.waitForURL(/\/batch$/)

  // A second, overlapping file: the same amount and direction one day later (a duplicate of the first row's own
  // transaction, not of itself), plus one new, unrelated row.
  const overlapping = bankSignedColumnCsv([
    signedRow(anchor, 1, "Phone Bill", "499.00", "-"),
    signedRow(anchor, 2, "New Subscription", "199.00", "-"),
  ])
  await uploadFile(page, "Bank", "second.csv", overlapping)
  await setMapping(page, { dateFormat: "DD-MMM-YYYY", dateCol: "Date", descCol: "Description", amountCol: "Amount" })
  await stageRows(page)
  await page.waitForURL(/\/review$/)

  const repeated = rowWith(page, "Phone Bill").filter({ hasText: "₹499.00" })
  await expect(repeated.getByRole("group", { name: "Possible duplicate" })).toContainText(printed(anchor))
  await expect(repeated.getByRole("group", { name: "Possible duplicate" })).toContainText("₹499.00")
  await expect(rowWith(page, "New Subscription").getByRole("group", { name: "Possible duplicate" })).toHaveCount(0)
})

test("an ambiguous date previews differently under each date format, and switching the control changes it", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "10,000")
  const year = (await today(userId)).slice(0, 4)
  await uploadFile(page, "Bank", "ambiguous.csv", bankSignedColumnCsv([row([`03/04/${year}`, "Ambiguous Row", "100.00"])]))

  // Columns chosen, date format left at the map screen's own default (DD/MM/YYYY): 3 April.
  await setMapping(page, { dateCol: "Date", descCol: "Description", amountCol: "Amount" })
  const preview = page.getByRole("region", { name: "Preview of the first 20 rows, as they will be recorded" })
  // Written out in words (final review I7), so the day previewed can never itself be misread under either format.
  await expect(preview).toContainText(`3 Apr ${year}`)

  // Switched to MM/DD/YYYY: the same text now reads as 4 March.
  await setMapping(page, { dateFormat: "MM/DD/YYYY" })
  await expect(preview).toContainText(`4 Mar ${year}`)
  await expect(preview).not.toContainText(`3 Apr ${year}`)

  // Final review I6: changing a control without updating the preview holds "Stage rows" back, so the mapping staged is
  // always the one previewed; updating the preview releases it.
  const stage = page.getByRole("button", { name: "Stage rows" })
  await expect(stage).toHaveAttribute("aria-disabled", "false")
  await page.getByLabel("Date format").selectOption("DD/MM/YYYY")
  await expect(stage).toHaveAttribute("aria-disabled", "true")
  await expect(page.getByText("Update the preview first", { exact: false }).first()).toBeVisible()
  await stage.click({ force: true })
  await expect(page).toHaveURL(/\/map(\?|$)/) // not staged: still on the map screen
  await page.getByLabel("Date format").selectOption("MM/DD/YYYY") // back to what the preview shows
  await expect(stage).toHaveAttribute("aria-disabled", "false")
  await page.getByLabel("Date format").selectOption("DD/MM/YYYY")
  await page.getByRole("button", { name: "Update preview" }).click()
  await expect(preview).toContainText(`3 Apr ${year}`)
  await expect(stage).toHaveAttribute("aria-disabled", "false")
})

test("a card statement's positive charges spend and a negative payment is money in, under POSITIVE_OUT", async ({ session: { page, userId } }) => {
  await card(userId, "Travel Card")
  const anchor = safeAnchor(await today(userId))
  const content = cardCsv([cardRow(anchor, 0, "Restaurant Charge", "250.00", "+"), cardRow(anchor, 1, "Card Payment", "500.00", "-")])
  await uploadFile(page, "Travel Card", "card.csv", content)

  await expect(page.getByText("A positive amount increases what this account owes, such as a new purchase; a negative amount decreases it, such as a payment.")).toBeVisible()
  await setMapping(page, { dateCol: "Date", descCol: "Description", amountCol: "Amount" })

  const preview = page.getByRole("region", { name: "Preview of the first 20 rows, as they will be recorded" })
  const rows = preview.getByRole("row")
  await expect(rows.filter({ hasText: "Restaurant Charge" })).toContainText("Out")
  await expect(rows.filter({ hasText: "Card Payment" })).toContainText("In")
})

test("a row matching a pending recurring occurrence offers to link it, and the occurrence is gone once committed", async ({
  session: { page, userId },
}) => {
  await account(userId, "Checking", "40,000")
  const due = await today(userId)
  await recurringRule(userId, { name: "Rent", from: "Checking", to: "Rent", rupees: "15,000", frequency: "WEEKLY", startDate: due })

  const bankDate = addDays(calendarDate(due), 1)
  await uploadFile(page, "Checking", "rent.csv", bankSignedColumnCsv([signedRow(calendarDate(due), 1, "Rent payment", "15,000.00", "-")]))
  await setMapping(page, { dateFormat: "DD-MMM-YYYY", dateCol: "Date", descCol: "Description", amountCol: "Amount" })
  await stageRows(page)
  await page.waitForURL(/\/review$/)

  const rentRow = rowWith(page, "Rent payment")
  await expect(rentRow.getByRole("group", { name: "Matches a recurring entry" })).toContainText("Rent")
  await expect(rentRow.getByRole("group", { name: "Matches a recurring entry" })).toContainText(printed(due))
  await rentRow.getByRole("button", { name: "Link to" }).click()
  await expect(page.getByRole("status")).toContainText("linked to Rent and ready to import")

  await page.getByRole("button", { name: "Commit", exact: true }).click()
  await page.waitForURL(/\/batch$/)
  await expect(statOf(page, "Linked to recurring")).toHaveText("1")

  // The occurrence is gone from the inbox...
  await page.goto("/recurring")
  await expect(page.getByRole("region", { name: "Inbox", exact: true }).getByRole("listitem")).toHaveCount(0)

  // ...and the transaction carries the bank's own date (one day after the rule's due date), not the rule's.
  await ledgerBetween(page, addDays(calendarDate(due), -5), addDays(calendarDate(due), 5))
  const posted = entries(page).getByRole("listitem").filter({ hasText: "Rent payment" })
  await expect(posted).toContainText("₹15,000.00")
  await expect(posted).toContainText(printed(bankDate))
})

test("a second import of a statement with the same description pre-fills the ledger it was taught, as Suggested", async ({
  session: { page, userId },
}) => {
  await account(userId, "Bank", "10,000")
  await addExpense(userId, "Shopping")
  const anchor = safeAnchor(await today(userId))

  await uploadFile(page, "Bank", "first.csv", bankSignedColumnCsv([signedRow(anchor, 0, "Amazon Purchase", "450.00", "-")]))
  await setMapping(page, { dateFormat: "DD-MMM-YYYY", dateCol: "Date", descCol: "Description", amountCol: "Amount" })
  await stageRows(page)
  await page.waitForURL(/\/review$/)
  await rowWith(page, "Amazon Purchase").getByLabel("Counterpart ledger").selectOption(await nodeId(userId, "Shopping"))
  await rowWith(page, "Amazon Purchase").getByRole("button", { name: "Import", exact: false }).click()
  await expect(page.getByRole("status")).toContainText("ready to import")
  await page.getByRole("button", { name: "Commit", exact: true }).click()
  await page.waitForURL(/\/batch$/)

  await uploadFile(page, "Bank", "second.csv", bankSignedColumnCsv([signedRow(anchor, 1, "Amazon Purchase", "275.50", "-")]))
  await setMapping(page, { dateFormat: "DD-MMM-YYYY", dateCol: "Date", descCol: "Description", amountCol: "Amount" })
  await stageRows(page)
  await page.waitForURL(/\/review$/)

  const select = rowWith(page, "Amazon Purchase").getByLabel("Counterpart ledger")
  const shoppingId = await nodeId(userId, "Shopping")
  await expect(select).toHaveValue(shoppingId)
  await expect(select.locator("option:checked")).toHaveText(/Suggested/)
})

test("deleting the ledger an import names is refused with the exact message", async ({ session: { page, userId } }) => {
  // No opening balance: this account has no history of its own, so the only thing standing between it and deletion is
  // the import that names it (an account with a transaction already refuses with a different message: "has transactions").
  await account(userId, "Checking")
  const anchor = safeAnchor(await today(userId))
  await uploadFile(page, "Checking", "named.csv", bankSignedColumnCsv([signedRow(anchor, 0, "Row", "10.00")]))

  await page.goto("/nodes")
  const checking = await openRow(page, "Checking")
  await checking.getByRole("button", { name: "Delete", exact: true }).click()
  await checking.getByRole("button", { name: "Confirm delete" }).click()
  await expect(checking.getByRole("alert")).toContainText("An import uses this ledger. Discard the import, or archive the ledger instead.")
  await expect(checking).toBeVisible()
})

test("the review page is worked by keyboard, reads in dark theme and reduced motion, and its wide preview table is keyboard-reachable", async ({
  session: { page, userId },
}) => {
  await account(userId, "Checking", "10,000")
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
  const anchor = safeAnchor(await today(userId))
  const content = bankSignedColumnCsv([signedRow(anchor, 0, "Shop A", "100.00", "-"), signedRow(anchor, 1, "Shop B", "200.00", "-")])
  await uploadFile(page, "Checking", "keyboard.csv", content)
  await setMapping(page, { dateFormat: "DD-MMM-YYYY", dateCol: "Date", descCol: "Description", amountCol: "Amount" })

  // The wide preview table scrolls inside its own labelled, focusable region: Tab reaches it before anything is staged.
  await tabTo(page, page.getByRole("region", { name: "Preview of the first 20 rows, as they will be recorded" }))
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
  ).toBe("Preview of the first 20 rows, as they will be recorded")
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.[0])).toBeDefined()
  expect((await page.evaluate(() => getComputedStyle(document.body).backgroundColor.match(/\d+/g)))?.map(Number)[0]).toBeLessThan(40)

  await stageRows(page)
  await page.waitForURL(/\/review$/)
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true)
  expect((await page.evaluate(() => getComputedStyle(document.body).backgroundColor.match(/\d+/g)))?.map(Number)[0]).toBeLessThan(40)

  // Shop A: Tab to the counterpart select (reachable), choose a ledger, Tab to Import, Enter.
  const shopA = rowWith(page, "Shop A")
  await tabTo(page, shopA.getByLabel("Counterpart ledger"))
  await shopA.getByLabel("Counterpart ledger").selectOption(await nodeId(userId, "Groceries"))
  await tabTo(page, shopA.getByRole("button", { name: "Import", exact: false }))
  await page.keyboard.press("Enter")
  await expect(page.getByRole("status")).toContainText("ready to import")

  // Shop B: Tab to Skip, Enter.
  await page.locator("body").focus()
  await tabTo(page, rowWith(page, "Shop B").getByRole("button", { name: "Skip", exact: false }))
  await page.keyboard.press("Enter")
  await expect(page.getByRole("status")).toContainText("will be skipped")

  // The commit bar: Tab to Commit, Enter.
  await page.locator("body").focus()
  await tabTo(page, page.getByRole("button", { name: "Commit", exact: true }))
  await page.keyboard.press("Enter")
  await page.waitForURL(/\/batch$/)
  await expect(statOf(page, "Imported")).toHaveText("1")
  await expect(statOf(page, "Skipped")).toHaveText("1")
})

/** Tab until `target` has the focus; fails if it is not reached, so a control that cannot be tabbed to fails the test. */
async function tabTo(page: Page, target: ReturnType<Page["getByRole"]>) {
  for (let i = 0; i < 150; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return
    await page.keyboard.press("Tab")
  }
  throw new Error(`Tab never reached ${String(target)}`)
}
