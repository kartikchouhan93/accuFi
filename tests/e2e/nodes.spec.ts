import { addNode, expect, openRow, row, section, test } from "./fixtures"
import { formatDay } from "@/lib/transaction-text"
import { account, buy, incomeSource, investment, post, price, today } from "./seed"

// The node management screen, driven through a real browser against a real server and database. Money is checked as
// the text the user reads (Indian grouping, a rupee sign, red "owed" wording) because that is the contract of this
// screen; the arithmetic underneath has its own unit tests.

test("creates a bank account with an opening balance and shows it", async ({ ledger: page }) => {
  await addNode(page, "Account", {
    Name: "HDFC Savings",
    "Account type": "Savings",
    Institution: "HDFC Bank",
    "Amount (₹)": "1,25,000.50",
  })
  await page.getByRole("button", { name: "Add account" }).click()

  await expect(page.getByRole("status")).toContainText("Added HDFC Savings")
  const accounts = section(page, "Accounts")
  await expect(accounts.getByRole("listitem")).toHaveCount(1)
  const created = row(page, "HDFC Savings")
  await expect(created).toContainText("HDFC Bank")
  await expect(created).toContainText("₹1,25,000.50")
  await expect(page.getByRole("region", { name: "Net worth" })).toContainText("₹1,25,000.50")
})

test("shows an investment valued by quantity at its value, and one with no price as not valued", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "1,00,000")
  await investment(userId, "Gold")
  await investment(userId, "Silver")
  await investment(userId, "Copper", { unit: "kg" })
  await buy(userId, "Bank", "Gold", "70,000", "10", "2026-01-01")
  await buy(userId, "Bank", "Silver", "2,000", "20", "2026-01-01")
  await buy(userId, "Bank", "Copper", "1,000", "10", "2026-01-01")
  await price(userId, "Gold", "7,800", "2026-03-01")
  const day = await today(userId)
  await price(userId, "Copper", "120", day)

  await page.goto("/nodes")
  const investments = section(page, "Investments")
  // 10 g of gold at 7,800 a gram, from a price of 1 Mar: stale. 10 kg of copper at 120, priced today: fresh. The silver
  // has no price, so the kind's total counts the gold and the copper, 78,000 + 1,200.
  await expect(row(page, "Gold")).toContainText("₹78,000.00")
  await expect(row(page, "Gold")).toContainText("as of 1 Mar 2026")
  await expect(row(page, "Gold")).toContainText("Stale")
  await expect(row(page, "Copper")).toContainText("₹1,200.00")
  await expect(row(page, "Copper")).toContainText(`as of ${formatDay(day)}`)
  await expect(row(page, "Copper")).not.toContainText("Stale")
  await expect(row(page, "Silver")).toContainText("Not valued")
  await expect(row(page, "Silver")).not.toContainText("₹")
  await expect(row(page, "Silver")).not.toContainText("as of")
  await expect(investments.getByRole("heading", { level: 2 }).locator("..")).toContainText("₹79,200.00")
  // The bank's 1,00,000 - 70,000 - 2,000 - 1,000 = 27,000, and 79,200 of investments: the silver is named, not counted.
  const worth = page.getByRole("region", { name: "Net worth", exact: true })
  await expect(worth.locator("p").first()).toHaveText("₹1,06,200.00")
  await expect(worth.getByRole("note").first()).toContainText("Silver could not be valued")
  await expect(worth.getByRole("note").nth(1)).toHaveText("Gold is valued at a price more than its stale window old.")
})

test("groups the list by kind", async ({ ledger: page }) => {
  await addNode(page, "Account", { Name: "Wallet cash", "Account type": "Cash" })
  await page.getByRole("button", { name: "Add account" }).click()
  await expect(page.getByRole("status")).toContainText("Added Wallet cash")

  await addNode(page, "Investment", { Name: "Digital gold", Valuation: "By quantity and unit price", Unit: "gram" })
  await page.getByRole("button", { name: "Add investment" }).click()
  await expect(page.getByRole("status")).toContainText("Added Digital gold")

  await addNode(page, "Liability", { Name: "Axis card", "Liability type": "Credit card" })
  await page.getByRole("button", { name: "Add liability" }).click()
  await expect(page.getByRole("status")).toContainText("Added Axis card")

  await addNode(page, "Income source", { Name: "Salary" })
  await page.getByRole("button", { name: "Add income source" }).click()
  await expect(page.getByRole("status")).toContainText("Added Salary")

  // All five kinds, in this order, each holding exactly what belongs to it. Expenses arrive from the starter ledgers.
  const headings = page.getByRole("heading", { level: 2 })
  await expect(headings.filter({ hasText: /^(Accounts|Investments|Liabilities|Income|Expenses)$/ })).toHaveText([
    "Accounts",
    "Investments",
    "Liabilities",
    "Income",
    "Expenses",
  ])
  await expect(section(page, "Accounts")).toContainText("Wallet cash")
  await expect(section(page, "Investments")).toContainText("Digital gold")
  await expect(section(page, "Liabilities")).toContainText("Axis card")
  await expect(section(page, "Income")).toContainText("Salary")
  await expect(section(page, "Expenses")).toContainText("Groceries")
  await expect(section(page, "Accounts")).not.toContainText("Axis card")
  await expect(section(page, "Expenses")).not.toContainText("Salary")
})

test("archives an account and hides it from the list by default", async ({ ledger: page }) => {
  await addNode(page, "Account", { Name: "Old savings", "Account type": "Savings", "Amount (₹)": "5,000" })
  await page.getByRole("button", { name: "Add account" }).click()
  await expect(row(page, "Old savings")).toBeVisible()
  await expect(page.getByRole("region", { name: "Net worth" })).toContainText("₹5,000.00")

  const old = await openRow(page, "Old savings")
  await old.getByRole("button", { name: "Archive", exact: true }).click()
  // The warning names what the account still holds, before anything is archived.
  await expect(old).toContainText("still holds ₹5,000.00")
  await expect(old).toContainText("net worth")
  await old.getByRole("button", { name: "Confirm archive" }).click()

  await expect(page.getByRole("status")).toContainText("Archived Old savings")
  await expect(row(page, "Old savings")).toHaveCount(0)
  // Hiding a row is display only: the archived balance is still counted, and the screen says so.
  await expect(page.getByRole("region", { name: "Net worth" })).toContainText("₹5,000.00")
  await expect(section(page, "Accounts")).toContainText("₹5,000.00")
  await expect(section(page, "Accounts")).toContainText("1 archived")
})

test("warns about what an account holds today, not about a deposit that is dated later", async ({ session: { page, userId } }) => {
  await incomeSource(userId, "Salary")
  await account(userId, "Waiting for pay")
  await post(userId, "Salary", "Waiting for pay", "5,000", { date: "2099-01-01" })
  await page.goto("/nodes")
  // Every balance on screen is as of today, so the account is at nothing and the dated deposit is in no figure.
  await expect(row(page, "Waiting for pay")).toContainText("₹0.00")

  const waiting = await openRow(page, "Waiting for pay")
  await waiting.getByRole("button", { name: "Archive", exact: true }).click()
  await expect(waiting.getByRole("button", { name: "Confirm archive" })).toBeVisible()
  await expect(waiting).toContainText("Archive Waiting for pay?")
  await expect(waiting).not.toContainText("still holds")
  await waiting.getByRole("button", { name: "Confirm archive" }).click()
  await expect(page.getByRole("status")).toContainText("Archived Waiting for pay.")
  await expect(page.getByRole("status")).not.toContainText("still holds")
})

test("lets an account refuse to be overdrawn, says as of when, and then refuses", async ({ ledger: page }) => {
  await addNode(page, "Account", { Name: "Guarded", "Account type": "Savings", "Amount (₹)": "100" })
  const guard = page.getByRole("checkbox", { name: "Block entries that would leave this account overdrawn as of today" })
  await expect(guard).not.toBeChecked()
  // The control says what it does and what it does not: one day, not the past.
  await expect(page.getByText("not across the past")).toBeVisible()
  await guard.check()
  await page.getByRole("button", { name: "Add account" }).click()
  await expect(page.getByRole("status")).toContainText("Added Guarded.")
  await expect(guard).not.toBeChecked() // the form starts again

  // It is the account's own setting from now on: a spend past what it holds is refused.
  await page.goto("/transactions")
  const record = page.getByRole("form", { name: "Record a transaction" })
  await record.getByLabel("From", { exact: true }).selectOption({ label: "Guarded" })
  await record.getByLabel("To", { exact: true }).selectOption({ label: "Groceries" })
  await record.getByLabel("Amount (₹)").fill("500")
  await record.getByRole("button", { name: "Record transaction" }).click()
  await expect(record.getByRole("alert")).toContainText("does not allow a negative balance")
})

test("points aria-controls at the details panel only while it exists", async ({ session: { page, userId } }) => {
  await account(userId, "Everyday", "100")
  await page.goto("/nodes")
  const toggle = row(page, "Everyday").getByRole("button", { expanded: false }).first()
  // Closed: there is no panel in the page, so there is nothing to control.
  await expect(toggle).not.toHaveAttribute("aria-controls")
  await toggle.click()
  const opened = row(page, "Everyday").getByRole("button", { expanded: true }).first()
  const panelId = await opened.getAttribute("aria-controls")
  expect(panelId).toBeTruthy()
  await expect(page.locator(`[id="${panelId}"]`)).toHaveCount(1)
  await opened.click()
  await expect(row(page, "Everyday").getByRole("button", { expanded: false }).first()).not.toHaveAttribute("aria-controls")
})

test("shows archived accounts when the filter is toggled", async ({ ledger: page }) => {
  await addNode(page, "Account", { Name: "Old savings", "Account type": "Savings", "Amount (₹)": "5,000" })
  await page.getByRole("button", { name: "Add account" }).click()
  const old = await openRow(page, "Old savings")
  await old.getByRole("button", { name: "Archive", exact: true }).click()
  await old.getByRole("button", { name: "Confirm archive" }).click()
  await expect(row(page, "Old savings")).toHaveCount(0)

  await page.getByRole("checkbox", { name: "Show archived" }).check()
  const shown = row(page, "Old savings")
  await expect(shown).toBeVisible()
  await expect(shown).toContainText("Archived")
  // Showing them changes no total.
  await expect(page.getByRole("region", { name: "Net worth" })).toContainText("₹5,000.00")

  const reopened = await openRow(page, "Old savings")
  await reopened.getByRole("button", { name: "Restore" }).click()
  await expect(page.getByRole("status")).toContainText("Restored Old savings")
  await page.getByRole("checkbox", { name: "Show archived" }).uncheck()
  await expect(row(page, "Old savings")).toBeVisible()
  await expect(section(page, "Accounts")).not.toContainText("archived")
})

test("does not offer rename or delete on a system node", async ({ ledger: page }) => {
  const system = await openRow(page, "Opening Balance")
  await expect(system).toContainText("System")
  await expect(system.getByRole("button", { name: "Rename" })).toHaveCount(0)
  await expect(system.getByRole("button", { name: "Delete" })).toHaveCount(0)
  await expect(system.getByRole("button", { name: "Archive" })).toHaveCount(0)

  // An ordinary expense ledger offers all three, so the absence above is about the system role.
  const groceries = await openRow(page, "Groceries")
  await expect(groceries.getByRole("button", { name: "Rename" })).toBeVisible()
  await expect(groceries.getByRole("button", { name: "Archive", exact: true })).toBeVisible()
  await expect(groceries.getByRole("button", { name: "Delete", exact: true })).toBeVisible()
})

test("shows money owed on a liability once, as owed, and subtracts it from net worth", async ({ ledger: page }) => {
  await addNode(page, "Account", { Name: "Salary account", "Account type": "Savings", "Amount (₹)": "50,000" })
  await page.getByRole("button", { name: "Add account" }).click()
  await expect(row(page, "Salary account")).toBeVisible()

  await addNode(page, "Liability", { Name: "HDFC card", "Liability type": "Credit card", "Amount (₹)": "12,000" })
  // A new liability's opening balance defaults to "Owed": the common case, and the one a user would otherwise get wrong.
  await expect(page.getByRole("radio", { name: "Owed" })).toBeChecked()
  await page.getByRole("button", { name: "Add liability" }).click()

  await expect(row(page, "HDFC card")).toContainText("₹12,000.00 owed")
  await expect(section(page, "Liabilities")).toContainText("₹12,000.00 owed")
  // 50,000 held less 12,000 owed. Subtracting the (already negative) balance again would read ₹62,000.00.
  await expect(page.getByRole("region", { name: "Net worth" })).toContainText("₹38,000.00")
  await expect(page.getByRole("region", { name: "Net worth" })).not.toContainText("₹62,000.00")
})

test("explains the sign of an opening balance and accepts an overdrawn account", async ({ ledger: page }) => {
  await page.getByRole("radio", { name: "Account", exact: true }).check()
  await page.getByLabel("Name", { exact: true }).fill("Current account")
  await page.getByLabel("Amount (₹)").fill("2,000")

  await expect(page.getByRole("radio", { name: "In credit" })).toBeChecked()
  await expect(page.getByText("You hold ₹2,000.00 in this account")).toBeVisible()

  await page.getByRole("radio", { name: "Overdrawn" }).check()
  await expect(page.getByText("You owe ₹2,000.00 on this account")).toBeVisible()

  await page.getByRole("button", { name: "Add account" }).click()
  await expect(row(page, "Current account")).toContainText("-₹2,000.00")
  await expect(page.getByRole("region", { name: "Net worth" })).toContainText("-₹2,000.00")
})

test("rejects a zero opening balance and keeps what was typed", async ({ ledger: page }) => {
  await addNode(page, "Account", { Name: "Empty", "Amount (₹)": "0" })
  await page.getByRole("button", { name: "Add account" }).click()

  await expect(page.getByText("Enter an amount other than zero")).toBeVisible()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Empty")
  await expect(row(page, "Empty")).toHaveCount(0)
})

test("changes the fields with the kind", async ({ ledger: page }) => {
  await page.getByRole("radio", { name: "Account", exact: true }).check()
  await expect(page.getByLabel("Account type")).toBeVisible()
  await expect(page.getByLabel("Amount (₹)")).toBeVisible()
  await expect(page.getByLabel("Unit", { exact: true })).toHaveCount(0)

  await page.getByRole("radio", { name: "Liability", exact: true }).check()
  await expect(page.getByLabel("Credit limit (₹)")).toBeVisible()
  await expect(page.getByLabel("Statement day")).toBeVisible()
  await expect(page.getByLabel("Due day")).toBeVisible()
  await expect(page.getByLabel("Account type")).toHaveCount(0)

  await page.getByRole("radio", { name: "Investment", exact: true }).check()
  await expect(page.getByLabel("Valuation")).toBeVisible()
  await expect(page.getByLabel("Unit", { exact: true })).toBeVisible()
  // An investment has no opening balance field: it is bought into with a transaction.
  await expect(page.getByLabel("Amount (₹)")).toHaveCount(0)

  await page.getByRole("radio", { name: "Income source", exact: true }).check()
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible()
  await expect(page.getByLabel("Institution")).toHaveCount(0)
})

test("warns about a duplicate name but keeps both", async ({ ledger: page }) => {
  for (let count = 0; count < 2; count++) {
    await addNode(page, "Account", { Name: "Cash in hand", "Account type": "Cash" })
    await page.getByRole("button", { name: "Add account" }).click()
    await expect(page.getByRole("status")).toContainText("Added Cash in hand")
  }
  await expect(page.getByRole("status")).toContainText("You already have an account called Cash in hand")
  await expect(section(page, "Accounts").getByRole("listitem")).toHaveCount(2)
})

test("renames a node", async ({ ledger: page }) => {
  const groceries = await openRow(page, "Groceries")
  await groceries.getByRole("button", { name: "Rename" }).click()
  await groceries.getByLabel("New name for Groceries").fill("Food and household")
  await groceries.getByRole("button", { name: "Save name" }).click()

  await expect(page.getByRole("status")).toContainText("Renamed Groceries to Food and household")
  await expect(row(page, "Food and household")).toBeVisible()
  await expect(row(page, "Groceries")).toHaveCount(0)
})

test("deletes a node with no history, and points to archiving when there is history", async ({ ledger: page }) => {
  const dining = await openRow(page, "Dining")
  await dining.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(dining).toContainText("cannot be undone")
  await dining.getByRole("button", { name: "Confirm delete" }).click()
  await expect(page.getByRole("status")).toContainText("Deleted Dining")
  await expect(row(page, "Dining")).toHaveCount(0)

  // The opening balance is a real transaction, so this account has history.
  await addNode(page, "Account", { Name: "Used account", "Account type": "Savings", "Amount (₹)": "100" })
  await page.getByRole("button", { name: "Add account" }).click()
  const used = await openRow(page, "Used account")
  await used.getByRole("button", { name: "Delete", exact: true }).click()
  await used.getByRole("button", { name: "Confirm delete" }).click()
  await expect(used.getByRole("alert")).toContainText("has transactions")
  await expect(used.getByRole("alert")).toContainText("Archive it instead")
  await expect(row(page, "Used account")).toBeVisible()
})
