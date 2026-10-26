import type { Page } from "@playwright/test"
import { addNode, expect, openRow, test } from "./fixtures"
import { account, buy, card, investment, price } from "./seed"

// The dashboard, driven through a real browser against a real server and database. The first test is the exit criterion
// of milestone 1: a month of ordinary activity, entered through the forms a user would use, and a net worth that matches
// a figure worked out by hand on paper. Every expected figure below is a literal from that arithmetic. None is read back
// from the application, and none is computed by code the application shares.

const form = (page: Page) => page.getByRole("form", { name: "Record a transaction" })

async function createOnLedger(page: Page, kind: string, fields: Record<string, string>, button: string, name: string) {
  await addNode(page, kind, fields)
  await page.getByRole("button", { name: button }).click()
  await expect(page.getByRole("status")).toContainText(`Added ${name}`)
}

/** Fill the transaction form and submit it; resolves once the form has cleared, which it only does for a recorded entry. */
async function record(page: Page, from: string, to: string, rupees: string, date?: string) {
  await form(page).getByLabel("From", { exact: true }).selectOption({ label: from })
  await form(page).getByLabel("To", { exact: true }).selectOption({ label: to })
  await form(page).getByLabel("Amount (₹)").fill(rupees)
  if (date !== undefined) await form(page).getByLabel("Date").fill(date)
  await form(page).getByRole("button", { name: "Record transaction" }).click()
  await expect(form(page).getByLabel("Amount (₹)")).toHaveValue("")
}

test("a full month reconciles", async ({ ledger: page }) => {
  // The books, opened through the ledger screen.
  await createOnLedger(page, "Income source", { Name: "Salary" }, "Add income source", "Salary")
  await createOnLedger(
    page,
    "Account",
    { Name: "HDFC Savings", "Account type": "Savings", "Amount (₹)": "50,000" },
    "Add account",
    "HDFC Savings",
  )
  await createOnLedger(page, "Account", { Name: "Cash wallet", "Account type": "Cash" }, "Add account", "Cash wallet")
  await createOnLedger(page, "Liability", { Name: "Axis card", "Liability type": "Credit card" }, "Add liability", "Axis card")
  await createOnLedger(
    page,
    "Investment",
    { Name: "Index fund", Valuation: "By what you put in", Unit: "unit" },
    "Add investment",
    "Index fund",
  )

  // The month, entered on the transaction screen.
  await page.goto("/transactions")
  await record(page, "Salary", "HDFC Savings", "85,000") //          salary in
  await record(page, "HDFC Savings", "Rent", "22,000.50") //         rent
  await record(page, "Axis card", "Groceries", "3,249.75") //        a card spend
  await record(page, "HDFC Savings", "Axis card", "2,000") //        part of the card bill paid
  await record(page, "HDFC Savings", "Index fund", "10,000") //      an SIP
  await record(page, "HDFC Savings", "Cash wallet", "5,000") //      a transfer to cash

  // Worked on paper, in rupees:
  //
  //   HDFC Savings   50,000.00 opening + 85,000.00 salary
  //                  - 22,000.50 rent - 2,000.00 card bill - 10,000.00 SIP - 5,000.00 to cash   =  95,999.50
  //   Cash wallet     5,000.00                                                                  =   5,000.00
  //   Accounts                                                                                  = 1,00,999.50
  //   Index fund     10,000.00                                                                  =  10,000.00
  //   Axis card      -3,249.75 spend + 2,000.00 bill paid = -1,249.75, so 1,249.75 is owed
  //
  //   Net worth = 1,00,999.50 + 10,000.00 - 1,249.75                                            = 1,09,749.75
  //
  // A second route to the same figure, which does not go through any balance: money entered the books as 50,000.00 +
  // 85,000.00 = 1,35,000.00, and the only money that left them is what was spent, 22,000.50 rent + 3,249.75 groceries
  // = 25,250.25. The transfers, the card bill and the SIP only moved it. 1,35,000.00 - 25,250.25 = 1,09,749.75.
  await page.goto("/")
  const worth = page.getByRole("region", { name: "Net worth", exact: true })
  await expect(worth.locator("p").first()).toHaveText("₹1,09,749.75")
  await expect(worth).toContainText("₹1,00,999.50 in accounts, ₹10,000.00 invested, ₹1,249.75 owed.")
  await expect(worth).not.toContainText(/partial|projected/i)

  const rows = (name: string) => page.getByRole("region", { name, exact: true }).getByRole("listitem")
  await expect(rows("Accounts").filter({ hasText: "HDFC Savings" })).toContainText("₹95,999.50")
  await expect(rows("Accounts").filter({ hasText: "Cash wallet" })).toContainText("₹5,000.00")
  await expect(rows("Investments").filter({ hasText: "Index fund" })).toContainText("₹10,000.00")
  await expect(rows("Liabilities").filter({ hasText: "Axis card" })).toContainText("₹1,249.75 owed")
  await expect(rows("Liabilities").filter({ hasText: "Axis card" })).not.toContainText("-")

  // The six entries of the month, newest first, are in the recent list.
  const recent = page.getByRole("region", { name: "Recent transactions" })
  await expect(recent).toContainText("HDFC Savings → Cash wallet")
  await expect(recent).toContainText("Axis card → Groceries")
  await expect(recent).toContainText("Salary → HDFC Savings")

  // Rent entered ahead of its day is not in today's figure. It is shown beside it as a projection:
  // 1,09,749.75 - 22,000.50 = 87,749.25.
  await page.goto("/transactions")
  await record(page, "HDFC Savings", "Rent", "22,000.50", "2099-01-01")
  await page.goto("/")
  await expect(worth.locator("p").first()).toHaveText("₹1,09,749.75")
  await expect(worth).toContainText("Projected ₹87,749.25 once everything dated up to 1 Jan 2099 has happened")
  await expect(rows("Accounts").filter({ hasText: "HDFC Savings" })).toContainText("₹95,999.50")
})

test("points a brand-new user at creating a first account", async ({ session: { page } }) => {
  await page.goto("/")
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Start with your first account" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Net worth" })).toHaveCount(0) // no wall of zeros
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page")

  await page.getByRole("link", { name: "Add your first account" }).click()
  await expect(page).toHaveURL(/\/nodes$/)
  await expect(page.getByRole("heading", { level: 1, name: "Ledger" })).toBeVisible()
})

test("still counts an account once it is archived, though the dashboard stops listing it", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "10,000")
  await card(userId, "Old card", { owed: "4,000" })
  await page.goto("/")
  const worth = page.getByRole("region", { name: "Net worth", exact: true })
  await expect(worth.locator("p").first()).toHaveText("₹6,000.00") // 10,000 held less 4,000 owed

  await page.goto("/nodes")
  const old = await openRow(page, "Old card")
  await old.getByRole("button", { name: "Archive", exact: true }).click()
  await old.getByRole("button", { name: "Confirm archive" }).click()
  await expect(page.getByRole("status")).toContainText("Archived Old card")

  await page.goto("/")
  // Not among the accounts (its opening balance is still a transaction, and the recent list says so).
  await expect(page.getByRole("region", { name: "Liabilities", exact: true }).getByRole("listitem")).toHaveCount(0)
  await expect(worth.locator("p").first()).toHaveText("₹6,000.00") // the debt is still owed
  await expect(worth).toContainText("Includes 1 archived")
  await expect(page.getByRole("region", { name: "Liabilities", exact: true })).toContainText("Includes 1 archived, not listed")
})

test("names an investment with no price instead of counting it, then counts it at its value once priced", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "2,00,000")
  await investment(userId, "Gold")
  await buy(userId, "Bank", "Gold", "70,000", "10", "2026-01-01")
  await buy(userId, "Bank", "Gold", "37,000", "5", "2026-02-01")

  await page.goto("/")
  const worth = page.getByRole("region", { name: "Net worth", exact: true })
  const gold = page.getByRole("region", { name: "Investments", exact: true }).getByRole("listitem").filter({ hasText: "Gold" })
  // 2,00,000 - 70,000 - 37,000 in the bank; the gold has no price, so it is named and left out, never shown as ₹0.
  await expect(worth.locator("p").first()).toHaveText("₹93,000.00")
  await expect(worth.getByRole("note")).toContainText("Partial figure: Gold could not be valued")
  await expect(gold).toContainText("Not valued")
  await expect(gold).toContainText("No price yet")
  await expect(gold).not.toContainText("₹")

  // 15 g at 7,800 a gram is 1,17,000; with the bank's 93,000 that is 2,10,000.
  await price(userId, "Gold", "7,800", "2026-03-01")
  await page.reload()
  await expect(worth.locator("p").first()).toHaveText("₹2,10,000.00")
  await expect(worth).toContainText("₹93,000.00 in accounts, ₹1,17,000.00 invested, ₹0.00 owed.")
  await expect(worth).not.toContainText(/partial/i)
  await expect(gold).toContainText("₹1,17,000.00")
})

test("sign-in and sign-up use the app's own look, not a default one", async ({ page }) => {
  for (const [path, heading] of [
    ["/login", "Sign in to AccuFi"],
    ["/signup", "Create your AccuFi account"],
  ] as const) {
    await page.goto(path)
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible()
    // The card is the app's own surface, not a framework default. Its background is the --panel token, resolved by the
    // browser the same way for the probe as for the form so the test holds in either theme; and since the light theme's panel
    // is plain white, the typefaces carry the rest of the claim: headings in Bricolage Grotesque, body text in Geist.
    const { card, panel, heading: headingFont, body } = await page.evaluate(() => {
      const probe = document.createElement("div")
      probe.style.background = "var(--panel)"
      document.body.append(probe)
      const panel = getComputedStyle(probe).backgroundColor
      probe.remove()
      return {
        card: getComputedStyle(document.querySelector("form") as HTMLElement).backgroundColor,
        panel,
        heading: getComputedStyle(document.querySelector("h1") as HTMLElement).fontFamily,
        body: getComputedStyle(document.body).fontFamily,
      }
    })
    expect(card).toBe(panel)
    expect(headingFont).toContain("Bricolage")
    expect(body).toContain("Geist")
  }
})
