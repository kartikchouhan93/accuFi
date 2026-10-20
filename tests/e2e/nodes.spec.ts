import { addNode, expect, openRow, row, section, test } from "./fixtures"

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
