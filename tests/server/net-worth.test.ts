import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { netWorth } from "@/domain/balance"
import { calendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { seedAccountNodes } from "@/server/services/account-seed"
import { todayFor } from "@/server/services/clock"
import { loadValuations } from "@/server/services/investment-service"
import { archiveLedgerNode, createLedgerNode } from "@/server/services/node-service"
import { recordPrice } from "@/server/services/price-service"
import { recordTransaction } from "@/server/services/transaction-service"
import { createRegistry } from "./repositories/fixtures"

// netWorth is pure and its unit tests hand it balances; sumBalances is SQL and its tests read balances back. Each side
// can be right while the pair is wrong (they once disagreed about the sign of a liability and both suites passed). These
// tests feed real sumBalances output, produced by real rows, into netWorth, so a convention mismatch fails here.

const registry = createRegistry()
afterAll(registry.cleanup)

async function world() {
  const user = await registry.makeUser()
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const card = await registry.makeNode(user.id, "LIABILITY", "Card")
  const loan = await registry.makeNode(user.id, "LIABILITY", "Loan")
  const salary = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  await registry.makeTransaction(user.id, salary.id, bank.id, { amountPaise: 100_000n })
  const worth = async () => netWorth(await sumBalances(user.id))
  const move = (from: string, to: string, amountPaise: bigint) =>
    registry.makeTransaction(user.id, from, to, { amountPaise })
  return { user, bank, card, loan, salary, food, worth, move }
}

describe("sumBalances feeding netWorth", () => {
  it("is reduced by a card spend", async () => {
    const { card, food, worth, move } = await world()
    const before = await worth()
    await move(card.id, food.id, 50_000n)
    const after = await worth()
    expect(after.total).toBe(before.total - 50_000n)
    expect(after.liabilities).toBe(50_000n) // reported as a positive magnitude owed
    expect(after.assets).toBe(before.assets)
  })

  it("is unchanged by borrowing into the bank", async () => {
    const { card, loan, bank, worth, move } = await world()
    const before = await worth()
    await move(loan.id, bank.id, 1_000_000n)
    const after = await worth()
    expect(after.total).toBe(before.total)
    expect(after.assets).toBe(before.assets + 1_000_000n)
    expect(after.liabilities).toBe(1_000_000n)
    expect(card.id).not.toBe(loan.id)
  })

  it("is unchanged by paying the card bill from the bank", async () => {
    const { card, food, bank, worth, move } = await world()
    await move(card.id, food.id, 40_000n)
    const owing = await worth()
    await move(bank.id, card.id, 40_000n)
    const settled = await worth()
    expect(settled.total).toBe(owing.total)
    expect(settled.liabilities).toBe(0n)
    expect(settled.assets).toBe(owing.assets - 40_000n)
  })

  it("counts an opening balance posted for a card you already owe on as debt", async () => {
    const user = await registry.makeUser()
    await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
    await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS", openingBalance: 1_000_00n })
    const before = netWorth(await sumBalances(user.id))
    await createLedgerNode(user.id, {
      kind: "LIABILITY",
      name: "Card",
      liabilitySubtype: "CREDIT_CARD",
      openingBalance: -500_00n,
    })
    const after = netWorth(await sumBalances(user.id))
    expect(before.total).toBe(1_000_00n)
    expect(after.liabilities).toBe(500_00n)
    expect(after.total).toBe(500_00n)
  })

  it("counts an overdrawn asset account as a negative asset", async () => {
    const user = await registry.makeUser()
    await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
    await createLedgerNode(user.id, { kind: "ASSET", name: "Overdraft", assetSubtype: "CURRENT", openingBalance: -200_00n })
    expect(netWorth(await sumBalances(user.id)).total).toBe(-200_00n)
  })

  it("is unchanged by archiving a card you still owe on", async () => {
    // EC-32: archiving removes the node from pickers and lists, never its balance from net worth. A summation that
    // skipped archived nodes would drop the debt and raise net worth by the amount owed.
    const { card, food, worth, move } = await world()
    await move(card.id, food.id, 50_000n)
    const owing = await worth()
    expect(owing.liabilities).toBe(50_000n)

    const { residualBalance } = await archiveLedgerNode(card.userId, card.id)

    expect(residualBalance).toBe(-50_000n)
    const archived = await worth()
    expect(archived.total).toBe(owing.total)
    expect(archived.liabilities).toBe(50_000n)
    expect(archived).toEqual(owing)
  })

  it("counts an investment valued by its lots at its value, from real lots and a real price, and reports one with no price", async () => {
    const { user, bank, salary, worth } = await world()
    const gold = await registry.makeNode(user.id, "INVESTMENT", "Gold", { valuationMode: "QUANTITY", unitLabel: "g" })
    const silver = await registry.makeNode(user.id, "INVESTMENT", "Silver", { valuationMode: "QUANTITY", unitLabel: "g" })
    await registry.makeTransaction(user.id, salary.id, bank.id, { amountPaise: 1_00_000_00n })
    const buy = (to: string, amount: bigint, grams: bigint) =>
      recordTransaction(user.id, {
        fromNodeId: bank.id,
        toNodeId: to,
        amount,
        quantity: grams * 1_000_000n,
        occurredAt: calendarDate("2026-04-01"),
        idempotencyKey: randomUUID(),
      })
    await buy(gold.id, 70_000_00n, 10n)
    await buy(silver.id, 1_000_00n, 1n)
    await recordPrice(user.id, { nodeId: gold.id, asOf: calendarDate("2026-04-02"), pricePerUnit: 7_800_00n })
    const today = await todayFor(user.id)

    const valued = netWorth(await sumBalances(user.id, today), await loadValuations(user.id, today))

    // The bank: 1,000 + 1,00,000 - 70,000 - 1,000 = 30,000. The gold: 10 g at 7,800 = 78,000. The silver: not valued.
    expect(valued).toMatchObject({ assets: 30_000_00n, investments: 78_000_00n, isPartial: true, unvaluedNodeIds: [silver.id] })
    expect(valued.total).toBe(1_08_000_00n)
    // Without valuations the same rows would count both at cost: the map is what changes the figure.
    expect((await worth()).investments).toBe(71_000_00n)
  })

  it("is unchanged by archiving an account that still holds money", async () => {
    const { bank, worth } = await world()
    const holding = await worth()
    expect(holding.assets).toBe(100_000n)
    await archiveLedgerNode(bank.userId, bank.id)
    expect(await worth()).toEqual(holding)
  })
})
