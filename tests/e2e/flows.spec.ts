import type { Page } from "@playwright/test"
import { parseRupees } from "@/domain/money"
import type { LedgerKind } from "@/domain/ledger-kind"
import { prisma } from "@/server/db"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { expect, row, section, test } from "./fixtures"
import { balanceOf, balances, entries, form, record } from "./screens"
import { account, addExpense, addNode, incomeSource, loan, nodeId } from "./seed"

// The flows of spec 4.1 that have service tests but had never been driven through the screens. They are the spec's
// central claim, that a node's kind and not the sign of an amount decides what money moving means: a transfer between
// your own accounts is neither income nor spending, a loan payment reduces the loan by the principal alone, a refund
// takes spending back, and income can go straight to a debt.
//
// Every figure is checked as the text a person reads, and again in the database wherever the sign convention or a total
// is the thing under test: a balance is inflows less outflows, so a loan owed on is negative, spending is positive, and
// income received is negative. Net worth is read from the ledger screen, which is the only screen that totals it.

const netWorth = (page: Page) => page.getByRole("region", { name: "Net worth", exact: true })
const worth = (page: Page) => netWorth(page).locator("p").first()
const legsOf = (page: Page) => entries(page).getByRole("list", { name: "Legs" }).getByRole("listitem")

/** A node's balance in paise, as the ledger holds it. */
async function balanceIn(userId: string, name: string): Promise<bigint> {
  const id = await nodeId(userId, name)
  const row = (await sumBalances(userId)).find((candidate) => candidate.nodeId === id)
  if (!row) throw new Error(`no balance for ${name}`)
  return row.balance
}

/** What the user's own income sources paid in and own expense ledgers took out, system nodes (opening positions) left out. */
async function incomeAndSpending(userId: string): Promise<Record<Extract<LedgerKind, "INCOME_SOURCE" | "EXPENSE">, bigint>> {
  const nodes = await prisma.ledgerNode.findMany({ where: { userId, systemRole: null } })
  const totals = await sumBalances(userId)
  const sum = (kind: LedgerKind) =>
    nodes.filter((node) => node.kind === kind).reduce((total, node) => total + (totals.find((t) => t.nodeId === node.id)?.balance ?? 0n), 0n)
  return { INCOME_SOURCE: sum("INCOME_SOURCE"), EXPENSE: sum("EXPENSE") }
}

/** The ledger screen shows no income and no spending: not a figure, and not the word for one, on any row. */
async function expectNoIncomeOrSpendingOnLedger(page: Page) {
  await page.goto("/nodes")
  await expect(page.getByRole("heading", { level: 1, name: "Ledger" })).toBeVisible()
  await expect(section(page, "Income").getByRole("listitem").filter({ hasNotText: "System" })).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText(/\b(spent|received)\b/)
  // Each of the starter expense ledgers is exactly where it was: nothing in it.
  for (const name of ["Groceries", "Rent", "Utilities", "Transport", "Dining", "Health"]) await expect(row(page, name)).toContainText("₹0.00")
}

/**
 * Money moved between two of the user's own accounts, entered through the form. The movement changes both balances and
 * nothing else: not net worth, not any income figure, not any spending figure, on any screen or in the database, and
 * the transaction is listed under neither income nor expense. Then a real spend is recorded, to show the same checks
 * would have seen one.
 */
async function ownMoneyMoves(
  { page, userId }: { page: Page; userId: string },
  move: {
    from: string
    to: string
    rupees: string
    note: string
    fromAfter: string
    toAfter: string
    worth: string
    /** How many of the two accounts were opened with a balance: each opening is an income-source entry in the list. */
    openings: number
    /** Net worth once the ₹500 spend at the end has been recorded. */
    worthAfterSpend: string
  },
) {
  await page.goto("/nodes")
  await expect(worth(page)).toHaveText(move.worth)
  const before = await incomeAndSpending(userId)
  expect(before).toEqual({ INCOME_SOURCE: 0n, EXPENSE: 0n })

  await page.goto("/transactions")
  await record(page, move.from, move.to, move.rupees, { note: move.note })
  await expect(page.getByRole("status")).toContainText(`Recorded ${move.from} → ${move.to}`)
  await expect(balanceOf(page, move.from)).toContainText(move.fromAfter)
  await expect(balanceOf(page, move.to)).toContainText(move.toAfter)

  // Both balances moved and net worth did not.
  await page.goto("/nodes")
  await expect(worth(page)).toHaveText(move.worth)
  await expect(row(page, move.from)).toContainText(move.fromAfter)
  await expect(row(page, move.to)).toContainText(move.toAfter)
  await expectNoIncomeOrSpendingOnLedger(page)
  expect(await incomeAndSpending(userId)).toEqual(before)

  // The list files it under neither income nor expense: the filters by kind find the opening balances, which are
  // income by origin, and never this transfer.
  const rows = entries(page).getByRole("listitem")
  await page.goto("/transactions?from=&to=&kind=EXPENSE")
  await expect(entries(page)).toContainText("Nothing recorded for these filters.")
  await page.goto("/transactions?from=&to=&kind=INCOME_SOURCE")
  await expect(rows.filter({ hasText: move.note })).toHaveCount(0)
  await expect(rows.filter({ hasText: "Opening Balance →" })).toHaveCount(move.openings)
  await page.goto("/transactions?from=&to=")
  await expect(rows.filter({ hasText: move.note })).toContainText(`${move.from} → ${move.to}`)

  // The check has teeth: a real spend of ₹500 shows as spending, once, and is the only thing that moves net worth.
  await page.goto("/transactions")
  await record(page, move.from, "Groceries", "500", { note: "A real spend" })
  await page.goto("/nodes")
  await expect(row(page, "Groceries")).toContainText("₹500.00 spent")
  await expect(worth(page)).toHaveText(move.worthAfterSpend)
  expect(await incomeAndSpending(userId)).toEqual({ INCOME_SOURCE: 0n, EXPENSE: parseRupees("500") })
}

test("a transfer between your own accounts is neither income nor spending", async ({ session }) => {
  await account(session.userId, "HDFC Savings", "50,000")
  await account(session.userId, "ICICI Savings", "10,000")
  await ownMoneyMoves(session, {
    from: "HDFC Savings",
    to: "ICICI Savings",
    rupees: "20,000",
    note: "Move to ICICI",
    fromAfter: "₹30,000.00",
    toAfter: "₹30,000.00",
    worth: "₹60,000.00",
    openings: 2,
    worthAfterSpend: "₹59,500.00",
  })
  expect(await balanceIn(session.userId, "HDFC Savings")).toBe(parseRupees("29,500"))
})

test("an ATM withdrawal is a transfer to cash, not an expense", async ({ session }) => {
  await account(session.userId, "HDFC Savings", "50,000")
  await addNode(session.userId, { kind: "ASSET", name: "Cash wallet", assetSubtype: "CASH" })
  await ownMoneyMoves(session, {
    from: "HDFC Savings",
    to: "Cash wallet",
    rupees: "5,000",
    note: "ATM withdrawal",
    fromAfter: "₹45,000.00",
    toAfter: "₹5,000.00",
    worth: "₹50,000.00",
    openings: 1,
    worthAfterSpend: "₹49,500.00",
  })
  expect(await balanceIn(session.userId, "Cash wallet")).toBe(parseRupees("5,000"))
})

test("an EMI entered as a split reduces the loan by the principal only", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "1,00,000")
  await loan(userId, "Home loan", "2,00,000")
  await addExpense(userId, "Loan interest")
  await page.goto("/nodes")
  await expect(row(page, "Home loan")).toContainText("₹2,00,000.00 owed")
  await expect(worth(page)).toHaveText("-₹1,00,000.00") // ₹1,00,000 held, ₹2,00,000 owed

  // The ₹10,000 payment: ₹8,000 of it principal, ₹2,000 interest, one event.
  await page.goto("/transactions")
  await form(page).getByLabel("From", { exact: true }).selectOption({ label: "HDFC Savings" })
  await form(page).getByRole("button", { name: "Add split" }).click()
  await form(page).getByLabel("Total (₹)").fill("10,000")
  const principal = form(page).getByRole("group", { name: "Leg 1" })
  const interest = form(page).getByRole("group", { name: "Leg 2" })
  await principal.getByLabel("To").selectOption({ label: "Home loan" })
  await principal.getByLabel("Amount (₹)").fill("8,000")
  await interest.getByLabel("To").selectOption({ label: "Loan interest" })
  await interest.getByLabel("Amount (₹)").fill("2,000")
  await expect(form(page).getByText("Nothing left to assign")).toBeVisible()
  await form(page).getByLabel("Note").fill("EMI October")
  await form(page).getByRole("button", { name: "Record split" }).click()
  await expect(page.getByRole("status")).toContainText("Recorded a split of ₹10,000.00 from HDFC Savings in 2 legs")

  // The loan owes ₹8,000 less, not ₹10,000 less; the account paid the whole ₹10,000.
  await expect(balanceOf(page, "Home loan")).toContainText("₹1,92,000.00 owed")
  await expect(balanceOf(page, "Home loan")).not.toContainText("₹1,90,000.00")
  await expect(balanceOf(page, "HDFC Savings")).toContainText("₹90,000.00")
  const event = entries(page).getByRole("listitem").filter({ hasText: "EMI October" })
  await expect(event).toHaveCount(1)
  await expect(event).toContainText("Split from HDFC Savings")
  await expect(event).toContainText("₹10,000.00")
  await event.getByRole("button", { expanded: false }).first().click()
  await expect(legsOf(page)).toHaveCount(2)
  await expect(legsOf(page).filter({ hasText: "Home loan" })).toContainText("₹8,000.00")
  await expect(legsOf(page).filter({ hasText: "Loan interest" })).toContainText("₹2,000.00")

  // On the ledger: the interest is spending, the loan is owed ₹1,92,000, and net worth fell by the interest alone.
  await page.goto("/nodes")
  await expect(row(page, "Home loan")).toContainText("₹1,92,000.00 owed")
  await expect(row(page, "Loan interest")).toContainText("₹2,000.00 spent")
  await expect(section(page, "Liabilities")).toContainText("₹1,92,000.00 owed")
  await expect(worth(page)).toHaveText("-₹1,02,000.00") // 90,000 held less 1,92,000 owed: ₹2,000 worse, the interest and nothing else
  await expect(netWorth(page)).toContainText("₹90,000.00 in accounts, ₹0.00 invested, ₹1,92,000.00 owed.")

  // In the database: the loan is negative by the principal's share, the interest ledger positive by its own, one group.
  expect(await balanceIn(userId, "Home loan")).toBe(-parseRupees("1,92,000"))
  expect(await balanceIn(userId, "Loan interest")).toBe(parseRupees("2,000"))
  expect(await balanceIn(userId, "HDFC Savings")).toBe(parseRupees("90,000"))
  const legs = await prisma.transaction.findMany({ where: { userId, groupId: { not: null } } })
  expect(legs).toHaveLength(2)
  expect(new Set(legs.map((leg) => leg.groupId)).size).toBe(1)
  expect(await incomeAndSpending(userId)).toEqual({ INCOME_SOURCE: 0n, EXPENSE: parseRupees("2,000") })
})

test("a refund takes spending back from the expense ledger it was spent on", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "20,000")
  await page.goto("/transactions")
  await record(page, "HDFC Savings", "Groceries", "2,000", { note: "Weekly shop" })
  await page.goto("/nodes")
  await expect(row(page, "Groceries")).toContainText("₹2,000.00 spent")
  await expect(worth(page)).toHaveText("₹18,000.00")

  await page.goto("/transactions")
  await record(page, "Groceries", "HDFC Savings", "500", { note: "Milk returned" })
  await expect(page.getByRole("status")).toContainText("Recorded Groceries → HDFC Savings")
  await expect(balanceOf(page, "HDFC Savings")).toContainText("₹18,500.00")
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Milk returned" })).toContainText("Groceries → HDFC Savings")

  // Spent ₹2,000, refunded ₹500: ₹1,500 spent, and ₹500 of net worth back.
  await page.goto("/nodes")
  await expect(row(page, "Groceries")).toContainText("₹1,500.00 spent")
  await expect(row(page, "Groceries")).not.toContainText("net refund")
  await expect(worth(page)).toHaveText("₹18,500.00")
  expect(await balanceIn(userId, "Groceries")).toBe(parseRupees("1,500"))
  expect(await incomeAndSpending(userId)).toEqual({ INCOME_SOURCE: 0n, EXPENSE: parseRupees("1,500") })
})

test("a refund larger than the spend is allowed, and the ledger reads as a net refund", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "20,000")
  await page.goto("/transactions")
  await record(page, "HDFC Savings", "Dining", "300", { note: "Dinner" })
  // EC-20: a returned item plus goodwill. It is accepted, not refused and not held up by a warning.
  await record(page, "Dining", "HDFC Savings", "450", { note: "Refund with goodwill" })
  await expect(page.getByRole("status")).toContainText("Recorded Dining → HDFC Savings")
  await expect(form(page).getByRole("alert")).toHaveCount(0)
  await expect(balanceOf(page, "HDFC Savings")).toContainText("₹20,150.00")
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Refund with goodwill" })).toContainText("₹450.00")

  // Spent ₹300, refunded ₹450: the ledger holds ₹150 more coming back than going out, said as such, with no minus sign.
  await page.goto("/nodes")
  const dining = row(page, "Dining")
  await expect(dining).toContainText("₹150.00 net refund")
  await expect(dining).not.toContainText("spent")
  await expect(dining).not.toContainText("-")
  await expect(worth(page)).toHaveText("₹20,150.00")
  expect(await balanceIn(userId, "Dining")).toBe(-parseRupees("150")) // the sign convention: below zero, the whole point of EC-20
  expect(await incomeAndSpending(userId)).toEqual({ INCOME_SOURCE: 0n, EXPENSE: -parseRupees("150") })
})

test("income applied straight to a loan reduces the debt without touching any account", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "10,000")
  await incomeSource(userId, "Salary")
  await loan(userId, "Personal loan", "50,000")
  await page.goto("/nodes")
  await expect(worth(page)).toHaveText("-₹40,000.00") // ₹10,000 held less ₹50,000 owed

  await page.goto("/transactions")
  await record(page, "Salary", "Personal loan", "20,000", { note: "Salary applied to the loan" })
  await expect(page.getByRole("status")).toContainText("Recorded Salary → Personal loan")
  await expect(balanceOf(page, "Personal loan")).toContainText("₹30,000.00 owed")
  // The money never touched an account.
  await expect(balanceOf(page, "HDFC Savings")).toContainText("₹10,000.00")
  await expect(balances(page)).not.toContainText("₹30,000.00 in credit")

  await page.goto("/nodes")
  await expect(row(page, "Personal loan")).toContainText("₹30,000.00 owed")
  await expect(row(page, "Salary")).toContainText("₹20,000.00 received")
  await expect(row(page, "HDFC Savings")).toContainText("₹10,000.00")
  await expect(worth(page)).toHaveText("-₹20,000.00") // ₹10,000 held less ₹30,000 owed
  await expect(netWorth(page)).toContainText("₹10,000.00 in accounts, ₹0.00 invested, ₹30,000.00 owed.")

  expect(await balanceIn(userId, "Personal loan")).toBe(-parseRupees("30,000"))
  expect(await balanceIn(userId, "Salary")).toBe(-parseRupees("20,000")) // an income source's balance is what it has paid out, negative
  expect(await balanceIn(userId, "HDFC Savings")).toBe(parseRupees("10,000"))
  // Nothing but the opening balance ever touched the account.
  expect(await prisma.transaction.count({ where: { userId, OR: [{ fromNodeId: await nodeId(userId, "HDFC Savings") }, { toNodeId: await nodeId(userId, "HDFC Savings") }] } })).toBe(1)
  expect(await incomeAndSpending(userId)).toEqual({ INCOME_SOURCE: -parseRupees("20,000"), EXPENSE: 0n })
})
