import { afterAll, describe, expect, it } from "vitest"
import { netWorth } from "@/domain/balance"
import { prisma } from "@/server/db"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { seedAccountNodes } from "@/server/services/account-seed"
import { createLedgerNode } from "@/server/services/node-service"
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
})
