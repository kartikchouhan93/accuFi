import { randomUUID } from "node:crypto"
import type { Page } from "@playwright/test"
import { parseRupees } from "@/domain/money"
import { prisma } from "@/server/db"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { archiveLedgerNode } from "@/server/services/node-service"
import { editTransaction, recordSplit } from "@/server/services/transaction-service"
import { expect, test } from "./fixtures"
import { account, addExpense, card, incomeSource, nodeId, post, today } from "./seed"

// The transaction screen, driven through a real browser against a real server and database. Money is checked as the
// text the user reads, and the rules (what is legal, what warns, what blocks) are checked where the user meets them.

const form = (page: Page) => page.getByRole("form", { name: "Record a transaction" })
const editForm = (page: Page) => page.getByRole("form", { name: "Edit transaction" })
const filters = (page: Page) => page.getByRole("form", { name: "Filter transactions" })
const entries = (page: Page) => page.getByRole("region", { name: "Entries" })
const balances = (page: Page) => page.getByRole("region", { name: "Balances" })

/** A split from the user's "HDFC Savings", dated today, with the same note on every leg, divided as the form's "divide equally" does. */
async function splitFromBank(userId: string, totalRupees: string, destinations: string[], note: string) {
  const { allocate } = await import("@/domain/money")
  const shares = allocate(parseRupees(totalRupees), destinations.map(() => 1n))
  const legs = await Promise.all(destinations.map(async (name, index) => ({ toNodeId: await nodeId(userId, name), amount: shares[index], note })))
  return recordSplit(userId, {
    fromNodeId: await nodeId(userId, "HDFC Savings"),
    occurredAt: await today(userId),
    legs,
    total: parseRupees(totalRupees),
    idempotencyKey: randomUUID(),
  })
}

/** The visible option labels of a select, without its placeholder. */
async function optionsOf(select: ReturnType<Page["getByLabel"]>): Promise<string[]> {
  const labels = await select.locator("option").allTextContents()
  return labels.filter((label) => label !== "" && !label.startsWith("Choose"))
}

test("records a salary credit and updates the account balance", async ({ session: { page, userId } }) => {
  await incomeSource(userId, "Salary")
  await account(userId, "HDFC Savings")
  await page.goto("/transactions")
  await expect(balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })).toContainText("₹0.00")

  await form(page).getByLabel("From", { exact: true }).selectOption({ label: "Salary" })
  await form(page).getByLabel("To", { exact: true }).selectOption({ label: "HDFC Savings" })
  await form(page).getByLabel("Amount (₹)").fill("85,000")
  await form(page).getByLabel("Note").fill("October salary")
  await form(page).getByRole("button", { name: "Record transaction" }).click()

  await expect(page.getByRole("status")).toContainText("Recorded Salary → HDFC Savings")
  const recorded = entries(page).getByRole("listitem").filter({ hasText: "October salary" })
  await expect(recorded).toContainText("Salary → HDFC Savings")
  await expect(recorded).toContainText("₹85,000.00")
  await expect(balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })).toContainText("₹85,000.00")
  // The form is ready for the next entry, not left holding the last one.
  await expect(form(page).getByLabel("Amount (₹)")).toHaveValue("")
  await expect(form(page).getByLabel("Note")).toHaveValue("")
})

test("offers only legal destinations once a source is chosen", async ({ session: { page, userId } }) => {
  await incomeSource(userId, "Salary")
  await incomeSource(userId, "Freelance")
  await account(userId, "HDFC Savings")
  await account(userId, "Cash wallet")
  await card(userId, "Axis card")
  await page.goto("/transactions")
  const from = form(page).getByLabel("From", { exact: true })
  const to = form(page).getByLabel("To", { exact: true })

  // Nothing to filter by yet: the destination waits for a source.
  await expect(to).toBeDisabled()

  // An income source pays into holdings and spends; it can never be paid into, and never pays another income source.
  await from.selectOption({ label: "Salary" })
  await expect(to).toBeEnabled()
  const fromIncome = await optionsOf(to)
  expect(fromIncome).toEqual(expect.arrayContaining(["HDFC Savings", "Cash wallet", "Axis card", "Groceries"]))
  expect(fromIncome).not.toContain("Freelance")
  expect(fromIncome).not.toContain("Salary")

  // An account can pay another account, a card and an expense, but not an income source, and not itself.
  await from.selectOption({ label: "HDFC Savings" })
  const fromAccount = await optionsOf(to)
  expect(fromAccount).toEqual(expect.arrayContaining(["Cash wallet", "Axis card", "Groceries"]))
  expect(fromAccount).not.toContain("Salary")
  expect(fromAccount).not.toContain("Freelance")
  expect(fromAccount).not.toContain("HDFC Savings")

  // Changing the source drops a destination that is no longer legal rather than leaving an impossible pair.
  await to.selectOption({ label: "Dining" })
  await from.selectOption({ label: "Groceries" })
  await expect(to).toHaveValue("")
  // A refund goes back to an account or a card, never to another expense.
  const fromExpense = await optionsOf(to)
  expect(fromExpense).toEqual(expect.arrayContaining(["HDFC Savings", "Axis card"]))
  expect(fromExpense).not.toContain("Dining")
})

test("omits archived accounts from the pickers", async ({ session: { page, userId } }) => {
  await account(userId, "Live account")
  const old = await account(userId, "Old savings")
  await archiveLedgerNode(userId, old.id)
  await page.goto("/transactions")

  const from = form(page).getByLabel("From", { exact: true })
  expect(await optionsOf(from)).toContain("Live account")
  expect(await optionsOf(from)).not.toContain("Old savings")
  await from.selectOption({ label: "Live account" })
  // Money can legally flow account to account, so an archived one would be offered here if nothing hid it.
  const to = form(page).getByLabel("To", { exact: true })
  expect(await optionsOf(to)).not.toContain("Old savings")
  expect(await optionsOf(to)).toContain("Groceries")
})

test("records a split across two expense ledgers from one form", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "10,000")
  await page.goto("/transactions")

  await form(page).getByLabel("From", { exact: true }).selectOption({ label: "HDFC Savings" })
  await form(page).getByRole("button", { name: "Add split" }).click()
  // A split replaces the single destination with legs; the amount becomes the total they must reach.
  await expect(form(page).getByRole("group", { name: /^Leg \d$/ })).toHaveCount(2)
  await form(page).getByLabel("Total (₹)").fill("100")
  const first = form(page).getByRole("group", { name: "Leg 1" })
  const second = form(page).getByRole("group", { name: "Leg 2" })
  await first.getByLabel("To").selectOption({ label: "Groceries" })
  await second.getByLabel("To").selectOption({ label: "Dining" })
  await form(page).getByRole("button", { name: "Add leg" }).click()
  await form(page).getByRole("group", { name: "Leg 3" }).getByLabel("To").selectOption({ label: "Transport" })

  // 100.00 in three: the odd paisa goes to the first leg, and the legs add up exactly (spec 6.3).
  await form(page).getByRole("button", { name: "Divide equally" }).click()
  await expect(first.getByLabel("Amount (₹)")).toHaveValue("33.34")
  await expect(second.getByLabel("Amount (₹)")).toHaveValue("33.33")
  await expect(form(page).getByRole("group", { name: "Leg 3" }).getByLabel("Amount (₹)")).toHaveValue("33.33")
  await expect(form(page).getByText("Nothing left to assign")).toBeVisible()

  await form(page).getByLabel("Note").fill("Weekend shopping")
  await form(page).getByRole("button", { name: "Record split" }).click()
  await expect(page.getByRole("status")).toContainText("Recorded a split of ₹100.00 from HDFC Savings in 3 legs")

  // One row for the event, the total on it, and the legs behind it.
  const group = entries(page).getByRole("listitem").filter({ hasText: "Weekend shopping" })
  await expect(group).toHaveCount(1)
  await expect(group).toContainText("Split")
  await expect(group).toContainText("₹100.00")
  await group.getByRole("button", { expanded: false }).first().click()
  const legs = group.getByRole("list", { name: "Legs" }).getByRole("listitem")
  await expect(legs).toHaveCount(3)
  await expect(legs.nth(0)).toContainText("₹33.34")
  await expect(group).toContainText("Groceries")
  await expect(group).toContainText("Dining")
  await expect(group).toContainText("Transport")
  await expect(balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })).toContainText("₹9,900.00")
})

test("shows the overdraft warning but still saves", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "1,000")
  await page.goto("/transactions")

  await form(page).getByLabel("From", { exact: true }).selectOption({ label: "HDFC Savings" })
  await form(page).getByLabel("To", { exact: true }).selectOption({ label: "Groceries" })
  await form(page).getByLabel("Amount (₹)").fill("1,500")
  await form(page).getByRole("button", { name: "Record transaction" }).click()

  // A warning is information, not a refusal: it is announced politely, not as an alert, and the entry is in the list.
  await expect(page.getByRole("status")).toContainText("Recorded HDFC Savings → Groceries")
  await expect(page.getByRole("status")).toContainText("HDFC Savings is overdrawn: its balance is -₹500.00")
  await expect(form(page).getByRole("alert")).toHaveCount(0)
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Groceries" })).toContainText("₹1,500.00")
  await expect(balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })).toContainText("-₹500.00")
})

test("filters by account and by date range", async ({ session: { page, userId } }) => {
  await incomeSource(userId, "Salary")
  await account(userId, "HDFC Savings")
  await account(userId, "Cash wallet")
  await post(userId, "Salary", "HDFC Savings", "50,000", { date: "2026-03-05", note: "March salary" })
  await post(userId, "HDFC Savings", "Groceries", "2,000", { date: "2026-03-12", note: "March groceries" })
  await post(userId, "HDFC Savings", "Cash wallet", "5,000", { date: "2026-03-15", note: "ATM withdrawal" })
  await post(userId, "HDFC Savings", "Dining", "800", { date: "2026-04-02", note: "April dinner" })
  await post(userId, "HDFC Savings", "Groceries", "300", { note: "Milk today" })
  const rows = entries(page).getByRole("listitem")
  await page.goto("/transactions")

  // The default is the current month, and the filter says so rather than leaving the range blank.
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("Milk today")
  const month = (await today(userId)).slice(0, 7)
  await expect(filters(page).getByLabel("From date")).toHaveValue(`${month}-01`)

  await filters(page).getByLabel("From date").fill("2026-03-01")
  await filters(page).getByLabel("To date").fill("2026-03-31")
  await filters(page).getByRole("button", { name: "Apply filters" }).click()
  await expect(page).toHaveURL(/from=2026-03-01/)
  await expect(rows).toHaveCount(3)
  await expect(entries(page)).not.toContainText("April dinner")
  await expect(entries(page)).not.toContainText("Milk today")

  // An account matches a transaction at either end of it.
  await filters(page).getByLabel("Involving").selectOption({ label: "Cash wallet" })
  await filters(page).getByRole("button", { name: "Apply filters" }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("ATM withdrawal")

  await filters(page).getByLabel("Involving").selectOption({ label: "Any account or ledger" })
  await filters(page).getByLabel("Kind involved").selectOption({ label: "Expense category" })
  await filters(page).getByRole("button", { name: "Apply filters" }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("March groceries")

  // Amount, tag and note filters narrow further.
  await filters(page).getByLabel("Kind involved").selectOption({ label: "Any kind" })
  await filters(page).getByLabel("Min amount (₹)").fill("10,000")
  await filters(page).getByRole("button", { name: "Apply filters" }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("March salary")
  await filters(page).getByLabel("Min amount (₹)").fill("")
  await filters(page).getByLabel("Note contains").fill("ATM")
  await filters(page).getByRole("button", { name: "Apply filters" }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("ATM withdrawal")
})

test("loads the next page without duplicating rows", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings")
  const when = await today(userId)
  const from = await nodeId(userId, "HDFC Savings")
  const to = await nodeId(userId, "Groceries")
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  const count = 57
  await prisma.transaction.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      userId: user.id,
      fromNodeId: from,
      toNodeId: to,
      amountPaise: 10_000n + BigInt(index),
      occurredAt: new Date(`${when}T00:00:00Z`),
      note: `Entry ${String(index + 1).padStart(2, "0")}`,
    })),
  })
  await page.goto("/transactions")
  const rows = entries(page).getByRole("listitem").filter({ hasText: "Entry" })
  await expect(rows).toHaveCount(50)

  await entries(page).getByRole("button", { name: "Load more" }).click()
  await expect(rows).toHaveCount(count)
  await expect(entries(page).getByRole("button", { name: "Load more" })).toHaveCount(0)
  // Every entry exactly once: a page boundary neither repeats a row nor skips one.
  const notes = (await rows.allTextContents()).map((text) => /Entry \d\d/.exec(text)?.[0])
  expect(new Set(notes).size).toBe(count)
})

test("double-clicking save creates exactly one transaction", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "1,000")
  const before = await prisma.transaction.count({ where: { userId } })
  await page.goto("/transactions")

  await form(page).getByLabel("From", { exact: true }).selectOption({ label: "HDFC Savings" })
  await form(page).getByLabel("To", { exact: true }).selectOption({ label: "Groceries" })
  await form(page).getByLabel("Amount (₹)").fill("250")
  await form(page).getByRole("button", { name: "Record transaction" }).dblclick()

  await expect(page.getByRole("status")).toContainText("Recorded HDFC Savings → Groceries")
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Groceries" })).toHaveCount(1)
  await expect.poll(() => prisma.transaction.count({ where: { userId } })).toBe(before + 1)
})

test("keeps the same request key when a refused entry is sent again", async ({ session: { page, userId } }) => {
  const guarded = await account(userId, "Guarded account", "100")
  await prisma.ledgerNode.update({ where: { id: guarded.id }, data: { blockNegative: true } })
  const keys: string[] = []
  page.on("request", (request) => {
    // Only Server Action posts carry this header; the page's own refreshes do not.
    if (request.method() === "POST" && request.headers()["next-action"]) {
      const key = /"([0-9a-f]{32})"/.exec(request.postData() ?? "")?.[1]
      if (key) keys.push(key)
    }
  })
  await page.goto("/transactions")

  await form(page).getByLabel("From", { exact: true }).selectOption({ label: "Guarded account" })
  await form(page).getByLabel("To", { exact: true }).selectOption({ label: "Groceries" })
  await form(page).getByLabel("Amount (₹)").fill("500")
  await form(page).getByRole("button", { name: "Record transaction" }).click()
  // This one IS a refusal: the account has said it never goes below zero. Nothing is written, and what was typed stays.
  await expect(form(page).getByRole("alert")).toContainText("does not allow a negative balance")
  await expect(form(page).getByLabel("Amount (₹)")).toHaveValue("500")
  expect(await prisma.transaction.count({ where: { userId, toNodeId: await nodeId(userId, "Groceries") } })).toBe(0)

  await form(page).getByLabel("Amount (₹)").fill("50")
  await form(page).getByRole("button", { name: "Record transaction" }).click()
  await expect(page.getByRole("status")).toContainText("Recorded Guarded account → Groceries")
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0]) // one key per opening of the form, not one per submit

  // The next entry is a new request and gets a new key.
  await form(page).getByLabel("To", { exact: true }).selectOption({ label: "Dining" })
  await form(page).getByLabel("Amount (₹)").fill("10")
  await form(page).getByRole("button", { name: "Record transaction" }).click()
  await expect.poll(() => keys.length).toBe(3)
  expect(keys[2]).not.toBe(keys[0])
})

test("puts a leg's problem on that leg, and a total that does not add up beside the total", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "10,000")
  const doomed = await addExpense(userId, "Doomed ledger")
  await page.goto("/transactions")
  await form(page).getByLabel("From", { exact: true }).selectOption({ label: "HDFC Savings" })
  await form(page).getByRole("button", { name: "Add split" }).click()
  await form(page).getByLabel("Total (₹)").fill("100")
  const first = form(page).getByRole("group", { name: "Leg 1" })
  const second = form(page).getByRole("group", { name: "Leg 2" })
  await first.getByLabel("To").selectOption({ label: "Groceries" })
  await second.getByLabel("To").selectOption({ label: "Doomed ledger" })

  // Legs that do not reach the total: refused by the server, and said beside the total, not as a page-level error.
  await first.getByLabel("Amount (₹)").fill("60")
  await second.getByLabel("Amount (₹)").fill("30")
  await form(page).getByRole("button", { name: "Record split" }).click()
  await expect(form(page).getByText("The legs add up to ₹90.00 but the total is ₹100.00.")).toBeVisible()
  await expect(form(page).getByLabel("Total (₹)")).toHaveAttribute("aria-invalid", "true")

  // Someone archives a ledger in another tab: the stale picker still offers it, and the refusal names leg 2, only.
  await archiveLedgerNode(userId, doomed.id)
  await second.getByLabel("Amount (₹)").fill("40")
  await form(page).getByRole("button", { name: "Record split" }).click()
  await expect(second).toContainText("Leg 2: The target node is archived.")
  await expect(first.getByLabel("To")).not.toHaveAttribute("aria-invalid", "true")
  await expect(second.getByLabel("To")).toHaveAttribute("aria-invalid", "true")
  // Neither refusal wrote anything: only the opening balance exists.
  expect(await prisma.transaction.count({ where: { userId } })).toBe(1)
})

test("deletes a whole split in one click and brings it back with undo", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "10,000")
  await splitFromBank(userId, "100", ["Groceries", "Dining", "Transport"], "Weekend shopping")
  await page.goto("/transactions")
  await expect(balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })).toContainText("₹9,900.00")
  const group = entries(page).getByRole("listitem").filter({ hasText: "Weekend shopping" })
  await group.getByRole("button", { expanded: false }).first().click()

  await group.getByRole("button", { name: "Delete split" }).click()
  await expect(page.getByRole("status")).toContainText("Deleted the split of ₹100.00")
  // One click, every leg: the entry is gone, the balance has its money back, and no leg is left behind in the list.
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Weekend shopping" })).toHaveCount(0)
  await expect(entries(page)).not.toContainText("Groceries")
  await expect(balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })).toContainText("₹10,000.00")
  expect(await prisma.transaction.count({ where: { userId, deletedAt: { not: null } } })).toBe(3)

  await page.getByRole("status").getByRole("button", { name: "Undo" }).click()
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Weekend shopping" })).toHaveCount(1)
  await expect(balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })).toContainText("₹9,900.00")
  expect(await prisma.transaction.count({ where: { userId, deletedAt: { not: null } } })).toBe(0)
})

test("finds a deleted transaction again after a reload and restores it, and the balance comes back", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "10,000")
  await post(userId, "HDFC Savings", "Groceries", "250", { note: "Wrong row" })
  await page.goto("/transactions")
  const bank = balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })
  await expect(bank).toContainText("₹9,750.00")
  const wrong = entries(page).getByRole("listitem").filter({ hasText: "Wrong row" })
  await wrong.getByRole("button", { expanded: false }).first().click()
  await wrong.getByRole("button", { name: "Delete" }).click()
  await expect(page.getByRole("status")).toContainText("Deleted HDFC Savings → Groceries")
  await expect(bank).toContainText("₹10,000.00")

  // The undo message is gone with the page: nothing on the list leads back to the entry until deleted ones are asked for.
  await page.reload()
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Wrong row" })).toHaveCount(0)
  await filters(page).getByLabel("Show deleted").check()
  await filters(page).getByRole("button", { name: "Apply filters" }).click()

  const found = entries(page).getByRole("listitem").filter({ hasText: "Wrong row" })
  await expect(found).toHaveCount(1)
  await expect(found).toContainText("Deleted")
  await expect(found).toContainText("₹250.00")
  // It is listed, not counted: the balance has not moved, and a deleted row offers a restore instead of an edit or a delete.
  await expect(bank).toContainText("₹10,000.00")
  await found.getByRole("button", { expanded: false }).first().click()
  await expect(found.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0)
  await expect(found.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0)

  await found.getByRole("button", { name: "Restore" }).click()
  await expect(page.getByRole("status")).toContainText("Restored.")
  await expect(bank).toContainText("₹9,750.00")
  await expect(found).not.toContainText("Deleted")
  expect(await prisma.transaction.count({ where: { userId, deletedAt: { not: null } } })).toBe(0)

  // And with deleted ones hidden again it is an ordinary entry.
  await page.goto("/transactions")
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Wrong row" })).toHaveCount(1)
})

test("finds a deleted split again after a reload and restores every leg together", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "10,000")
  await splitFromBank(userId, "100", ["Groceries", "Dining"], "Weekend shopping")
  await page.goto("/transactions")
  const bank = balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })
  const group = entries(page).getByRole("listitem").filter({ hasText: "Weekend shopping" })
  await group.getByRole("button", { expanded: false }).first().click()
  await group.getByRole("button", { name: "Delete split" }).click()
  await expect(bank).toContainText("₹10,000.00")

  await page.goto("/transactions?from=&to=&deleted=1")
  await expect(filters(page).getByLabel("Show deleted")).toBeChecked()
  const found = entries(page).getByRole("listitem").filter({ hasText: "Weekend shopping" })
  await expect(found).toHaveCount(1)
  await expect(found).toContainText("Deleted")
  await found.getByRole("button", { expanded: false }).first().click()
  await expect(found.getByRole("button", { name: /out of the split/ })).toHaveCount(0)
  await found.getByRole("button", { name: "Restore split" }).click()
  await expect(page.getByRole("status")).toContainText("Restored.")
  await expect(bank).toContainText("₹9,900.00")
  expect(await prisma.transaction.count({ where: { userId, deletedAt: { not: null } } })).toBe(0)
})

test("takes one leg out of a split and leaves the money where it went", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "10,000")
  await splitFromBank(userId, "100", ["Groceries", "Dining"], "Weekend shopping")
  await page.goto("/transactions")
  const group = entries(page).getByRole("listitem").filter({ hasText: "Weekend shopping" })
  await group.getByRole("button", { expanded: false }).first().click()

  // Said before it is done: with two legs, taking one out is taking both out.
  await expect(group).toContainText("dissolves the split")
  await group.getByRole("button", { name: "Take Dining out of the split" }).click()
  await expect(page.getByRole("status")).toContainText("The split is dissolved: Dining, ₹50.00, and Groceries, ₹50.00, are both ordinary transactions now.")
  await expect(page.getByRole("status")).not.toContainText("Took")
  // A group of one is not a split, so both legs are ordinary rows now, and the balance has not moved.
  await expect(entries(page).getByRole("listitem").filter({ hasText: "HDFC Savings → Groceries" })).toBeVisible()
  await expect(entries(page).getByRole("listitem").filter({ hasText: "HDFC Savings → Dining" })).toBeVisible()
  await expect(entries(page)).not.toContainText("Split from")
  await expect(balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })).toContainText("₹9,900.00")
})

test("edits one leg of a split without leaving the split", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "10,000")
  await splitFromBank(userId, "100", ["Groceries", "Dining"], "Weekend shopping")
  await page.goto("/transactions")
  const bank = balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })
  const group = entries(page).getByRole("listitem").filter({ hasText: "Weekend shopping" })
  await group.getByRole("button", { expanded: false }).first().click()

  await group.getByRole("button", { name: "Edit the Dining leg" }).click()
  await expect(editForm(page)).toBeVisible()
  await expect(editForm(page).getByLabel("To", { exact: true })).toHaveValue(await nodeId(userId, "Dining"))
  await editForm(page).getByLabel("Amount (₹)").fill("30")
  await editForm(page).getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByRole("status")).toContainText("Saved changes to HDFC Savings → Dining, ₹30.00")

  // Still one split, now of ₹80.00: its total is the sum of its legs as they are, and the account has the other ₹20.00 back.
  const after = entries(page).getByRole("listitem").filter({ hasText: "Weekend shopping" })
  await expect(after).toHaveCount(1)
  await expect(after).toContainText("Split from HDFC Savings")
  await expect(after).toContainText("₹80.00")
  await expect(bank).toContainText("₹9,920.00")
  expect(await prisma.transaction.count({ where: { userId, groupId: { not: null } } })).toBe(2)
})

test("edits a transaction that points at an archived account", async ({ session: { page, userId } }) => {
  const old = await account(userId, "Old savings", "5,000")
  await post(userId, "Old savings", "Groceries", "200", { note: "Before archiving" })
  await archiveLedgerNode(userId, old.id)
  await page.goto("/transactions")
  const row = entries(page).getByRole("listitem").filter({ hasText: "Before archiving" })
  await row.getByRole("button", { expanded: false }).first().click()
  await row.getByRole("button", { name: "Edit" }).click()

  // History stays correctable: the archived account is on offer for this row, marked, and only for this row.
  await expect(editForm(page)).toBeVisible()
  await expect(editForm(page).getByLabel("From", { exact: true })).toHaveValue(old.id)
  expect(await optionsOf(editForm(page).getByLabel("From", { exact: true }))).toContain("Old savings (archived)")
  await editForm(page).getByLabel("Amount (₹)").fill("250")
  await editForm(page).getByLabel("Note").fill("Corrected")
  await editForm(page).getByRole("button", { name: "Save changes" }).click()

  await expect(page.getByRole("status")).toContainText("Saved changes to Old savings → Groceries, ₹250.00")
  const edited = entries(page).getByRole("listitem").filter({ hasText: "Corrected" })
  await expect(edited).toContainText("₹250.00")
  await expect(form(page).getByRole("heading", { name: "Record a transaction" })).toBeVisible()
  // Back in new-entry mode the archived account is not offered again.
  expect(await optionsOf(form(page).getByLabel("From", { exact: true }))).not.toContain("Old savings (archived)")
})

test("shows both versions when a transaction was changed somewhere else", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "5,000")
  const recorded = await post(userId, "HDFC Savings", "Groceries", "200", { note: "Original" })
  await page.goto("/transactions")
  const row = entries(page).getByRole("listitem").filter({ hasText: "Original" })
  await row.getByRole("button", { expanded: false }).first().click()
  await row.getByRole("button", { name: "Edit" }).click()

  // Another tab (here, the service) saves first.
  await editTransaction(userId, recorded.id, { note: "Changed elsewhere", amount: parseRupees("300") }, recorded.version)
  await editForm(page).getByLabel("Note").fill("My edit")
  await editForm(page).getByRole("button", { name: "Save changes" }).click()

  const conflict = editForm(page).getByRole("alert")
  await expect(conflict).toContainText("changed somewhere else")
  await expect(conflict).toContainText("Stored now: HDFC Savings → Groceries, ₹300.00")
  await expect(conflict).toContainText("Changed elsewhere")
  await expect(editForm(page).getByLabel("Note")).toHaveValue("My edit")

  await conflict.getByRole("button", { name: "Use the stored version" }).click()
  await expect(editForm(page).getByLabel("Note")).toHaveValue("Changed elsewhere")
  await expect(editForm(page).getByLabel("Amount (₹)")).toHaveValue("300.00")
  await editForm(page).getByLabel("Note").fill("Merged by hand")
  await editForm(page).getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByRole("status")).toContainText("Saved changes")
  await expect(entries(page).getByRole("listitem").filter({ hasText: "Merged by hand" })).toContainText("₹300.00")
})

test("leaves a future-dated transaction out of every current balance and marks it projected", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "1,000")
  await post(userId, "HDFC Savings", "Rent", "400", { date: "2099-01-01", note: "Rent in advance" })
  await page.goto("/transactions?from=&to=")

  const row = entries(page).getByRole("listitem").filter({ hasText: "Rent in advance" })
  await expect(row).toContainText("Projected")
  await expect(balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })).toContainText("₹1,000.00")
  // The ledger screen agrees with this one, rather than showing the projected figure as the current one.
  await page.getByRole("link", { name: "Ledger" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Ledger" })).toBeVisible()
  await expect(page.getByRole("listitem").filter({ hasText: "HDFC Savings" })).toContainText("₹1,000.00")
})

test("shows what is owed on a card as owed, and paying it down reduces that once", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "50,000")
  await card(userId, "Axis card", { owed: "12,000" })
  await page.goto("/transactions")
  const cardLine = balances(page).getByRole("listitem").filter({ hasText: "Axis card" })
  await expect(cardLine).toContainText("₹12,000.00 owed")

  await form(page).getByLabel("From", { exact: true }).selectOption({ label: "HDFC Savings" })
  await form(page).getByLabel("To", { exact: true }).selectOption({ label: "Axis card" })
  await form(page).getByLabel("Amount (₹)").fill("5,000")
  await form(page).getByRole("button", { name: "Record transaction" }).click()
  await expect(page.getByRole("status")).toContainText("Recorded HDFC Savings → Axis card")
  // Owed 12,000, paid 5,000: owed 7,000. Not 17,000 (negated twice) and not "in credit".
  await expect(cardLine).toContainText("₹7,000.00 owed")
  await expect(cardLine).not.toContainText("17,000")
  await expect(balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })).toContainText("₹45,000.00")
})

test("records a backdated entry on the day given and counts it in today's balance", async ({ session: { page, userId } }) => {
  await incomeSource(userId, "Salary")
  await account(userId, "HDFC Savings")
  await page.goto("/transactions")

  await form(page).getByLabel("From", { exact: true }).selectOption({ label: "Salary" })
  await form(page).getByLabel("To", { exact: true }).selectOption({ label: "HDFC Savings" })
  await form(page).getByLabel("Amount (₹)").fill("40,000")
  await form(page).getByLabel("Date").fill("2026-03-05")
  await form(page).getByLabel("Note").fill("March salary, entered late")
  await form(page).getByRole("button", { name: "Record transaction" }).click()
  await expect(page.getByRole("status")).toContainText("Recorded Salary → HDFC Savings")
  await expect(balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })).toContainText("₹40,000.00")

  // It is dated March, so the current month's list does not hold it; the whole history does, on the day given.
  await page.goto("/transactions?from=&to=")
  await expect(entries(page).getByRole("listitem").filter({ hasText: "March salary, entered late" })).toContainText("5 Mar 2026")
})

test("says when a recorded entry falls outside the dates being listed", async ({ session: { page, userId } }) => {
  await incomeSource(userId, "Salary")
  await account(userId, "HDFC Savings")
  await page.goto("/transactions")
  const record = async (date: string) => {
    await form(page).getByLabel("From", { exact: true }).selectOption({ label: "Salary" })
    await form(page).getByLabel("To", { exact: true }).selectOption({ label: "HDFC Savings" })
    await form(page).getByLabel("Amount (₹)").fill("100")
    await form(page).getByLabel("Date").fill(date)
    await form(page).getByRole("button", { name: "Record transaction" }).click()
  }

  await record("2026-03-05")
  await expect(page.getByRole("status")).toContainText("Recorded Salary → HDFC Savings")
  await expect(page.getByRole("status")).toContainText("Dated 5 Mar 2026, outside the dates listed.")

  // An entry on a listed day needs no such line.
  await record(await today(userId))
  await expect(page.getByRole("status")).toContainText("Recorded Salary → HDFC Savings")
  await expect(page.getByRole("status")).not.toContainText("outside the dates listed")
})

test("two submits sent at once make one request, whatever the button does", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings", "1,000")
  let posts = 0
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) posts += 1
  })
  await page.goto("/transactions")
  await form(page).getByLabel("From", { exact: true }).selectOption({ label: "HDFC Savings" })
  await form(page).getByLabel("To", { exact: true }).selectOption({ label: "Groceries" })
  await form(page).getByLabel("Amount (₹)").fill("250")

  // Two submit events in the same turn: they bypass the disabled button, so only the form's own guard can stop the second.
  await form(page).evaluate((element) => {
    const target = element as HTMLFormElement
    target.requestSubmit()
    target.requestSubmit()
  })
  await expect(page.getByRole("status")).toContainText("Recorded HDFC Savings → Groceries")
  await page.waitForTimeout(500) // a second request, if there were one, would have been sent by now
  expect(posts).toBe(1)
  expect(await prisma.transaction.count({ where: { userId, toNodeId: await nodeId(userId, "Groceries") } })).toBe(1)
})

test("records an opening balance against an account that has none, from the Setup group of sources", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings") // created without an opening balance, and now it is forgotten
  await page.goto("/transactions")
  const from = form(page).getByLabel("From", { exact: true })
  const to = form(page).getByLabel("To", { exact: true })

  // The opening-balance node is offered, apart from the other sources, and only as a source.
  await expect(from.locator("optgroup[label='Setup'] option")).toHaveText(["Opening Balance"])
  await from.selectOption({ label: "Opening Balance" })
  const destinations = await optionsOf(to)
  expect(destinations).toContain("HDFC Savings")
  expect(destinations).not.toContain("Groceries") // an opening balance goes to an account or a card
  expect(destinations).not.toContain("Opening Balance Contra")
  await to.selectOption({ label: "HDFC Savings" })
  await form(page).getByLabel("Amount (₹)").fill("25,000")
  await form(page).getByLabel("Note").fill("Opening balance")
  await form(page).getByRole("button", { name: "Record transaction" }).click()

  await expect(page.getByRole("status")).toContainText("Recorded Opening Balance → HDFC Savings, ₹25,000.00")
  await expect(balances(page).getByRole("listitem").filter({ hasText: "HDFC Savings" })).toContainText("₹25,000.00")
})

test("records a forgotten negative opening position on a card, against the contra node, and the card then shows it owed", async ({ session: { page, userId } }) => {
  await account(userId, "HDFC Savings")
  await card(userId, "Axis card") // created owing nothing; the user now remembers it carried a balance
  await page.goto("/transactions")
  const cardLine = balances(page).getByRole("listitem").filter({ hasText: "Axis card" })
  await expect(cardLine).toContainText("₹0.00")

  // A negative opening position posts card -> Opening Balance Contra: the contra is a destination, in Setup.
  await form(page).getByLabel("From", { exact: true }).selectOption({ label: "Axis card" })
  const to = form(page).getByLabel("To", { exact: true })
  await expect(to.locator("optgroup[label='Setup'] option")).toHaveText(["Opening Balance Contra"])
  await to.selectOption({ label: "Opening Balance Contra" })
  await form(page).getByLabel("Amount (₹)").fill("12,000")
  await form(page).getByLabel("Note").fill("Opening balance")
  await form(page).getByRole("button", { name: "Record transaction" }).click()

  await expect(page.getByRole("status")).toContainText("Recorded Axis card → Opening Balance Contra, ₹12,000.00")
  // The balance is negative by the amount, which the screen reads as money owed, once.
  await expect(cardLine).toContainText("₹12,000.00 owed")
  const stored = await prisma.transaction.findFirstOrThrow({ where: { userId, fromNodeId: await nodeId(userId, "Axis card") } })
  expect(stored.amountPaise).toBe(1_200_000n)
  const balance = (await sumBalances(userId)).find((row) => row.nodeId === stored.fromNodeId)?.balance
  expect(balance).toBe(-1_200_000n)
})

// The four system roles against both positions: Opening Balance only as a source, the contra only as a destination,
// the realised gain and loss in neither. Written as a table so a later milestone cannot quietly widen it.
const SYSTEM_POSITIONS = [
  { name: "Opening Balance", asSource: true, asDestination: false },
  { name: "Opening Balance Contra", asSource: false, asDestination: true },
  { name: "Realised Gain", asSource: false, asDestination: false },
  { name: "Realised Loss", asSource: false, asDestination: false },
]
for (const { name, asSource, asDestination } of SYSTEM_POSITIONS) {
  test(`offers ${name} ${asSource ? "as a source" : "not as a source"} and ${asDestination ? "as a destination" : "not as a destination"}`, async ({
    session: { page, userId },
  }) => {
    await account(userId, "HDFC Savings")
    await card(userId, "Axis card")
    await page.goto("/transactions")
    const from = form(page).getByLabel("From", { exact: true })
    const to = form(page).getByLabel("To", { exact: true })
    expect(await optionsOf(from)).toEqual(asSource ? expect.arrayContaining([name]) : expect.not.arrayContaining([name]))
    for (const source of ["HDFC Savings", "Axis card"]) {
      await from.selectOption({ label: source })
      expect(await optionsOf(to), `${source} -> ${name}`).toEqual(asDestination ? expect.arrayContaining([name]) : expect.not.arrayContaining([name]))
    }
  })
}

test("flags the source field, not the destination, when the source was archived in another tab", async ({ session: { page, userId } }) => {
  const old = await account(userId, "HDFC Savings", "1,000")
  await page.goto("/transactions")
  await form(page).getByLabel("From", { exact: true }).selectOption({ label: "HDFC Savings" })
  await form(page).getByLabel("To", { exact: true }).selectOption({ label: "Groceries" })
  await form(page).getByLabel("Amount (₹)").fill("100")
  await archiveLedgerNode(userId, old.id)
  await form(page).getByRole("button", { name: "Record transaction" }).click()

  await expect(form(page).getByText("The source node is archived.")).toBeVisible()
  await expect(form(page).getByLabel("From", { exact: true })).toHaveAttribute("aria-invalid", "true")
  await expect(form(page).getByLabel("To", { exact: true })).not.toHaveAttribute("aria-invalid", "true")
  await expect(form(page).getByLabel("From", { exact: true })).toBeFocused()
})
