import { randomUUID } from "node:crypto"
import type { LedgerNode, User } from "@prisma/client"
import { calendarDate } from "@/domain/calendar-date"
import { QUANTITY_SCALE } from "@/domain/quantity"
import { prisma } from "@/server/db"
import { softDeleteTransaction } from "@/server/repositories/transaction-repository"
import { seedAccountNodes } from "@/server/services/account-seed"
import { sellInvestment } from "@/server/services/investment-service"
import { createLedgerNode } from "@/server/services/node-service"
import { recordPrice } from "@/server/services/price-service"
import { recordTransaction } from "@/server/services/transaction-service"
import type { createRegistry } from "../repositories/fixtures"

// The two worlds the report tests share (plan "Shared scenarios"). Each is built through the application's own
// services, so every row passed the same legality rules the app enforces. The expected figures live in the tests that
// use them, as hand-worked literals; nothing here computes one.

type Registry = ReturnType<typeof createRegistry>
export interface Scenario {
  user: User
  /** Every node of the user by name, the starter ledgers and the four system nodes included. */
  nodes: Record<string, LedgerNode>
}

async function newUser(registry: Registry): Promise<User> {
  const user = await registry.makeUser()
  await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
  return user
}

async function nodesOf(userId: string): Promise<Record<string, LedgerNode>> {
  const all = await prisma.ledgerNode.findMany({ where: { userId } })
  return Object.fromEntries(all.map((node) => [node.name, node]))
}

const rupees = (amount: number): bigint => BigInt(amount) * 100n

function poster(userId: string, nodes: () => Record<string, LedgerNode>) {
  return (from: string, to: string, amountRupees: number, day: string, extra: { quantity?: bigint } = {}) =>
    recordTransaction(userId, {
      fromNodeId: nodes()[from].id,
      toNodeId: nodes()[to].id,
      amount: rupees(amountRupees),
      occurredAt: calendarDate(day),
      quantity: extra.quantity,
      idempotencyKey: randomUUID(),
    })
}

/** Scenario F: income, spending, a card, refunds, a transfer, a hierarchy and one soft-deleted entry. */
export async function flowScenario(registry: Registry): Promise<Scenario> {
  const user = await newUser(registry)
  await createLedgerNode(user.id, { kind: "INCOME_SOURCE", name: "Salary" })
  await createLedgerNode(user.id, { kind: "INCOME_SOURCE", name: "Interest" })
  await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS" })
  await createLedgerNode(user.id, { kind: "ASSET", name: "Savings", assetSubtype: "SAVINGS" })
  await createLedgerNode(user.id, { kind: "LIABILITY", name: "Card", liabilitySubtype: "CREDIT_CARD" })
  await createLedgerNode(user.id, { kind: "EXPENSE", name: "Food" })
  let nodes = await nodesOf(user.id)
  await prisma.ledgerNode.update({ where: { id: nodes.Groceries.id }, data: { parentId: nodes.Food.id } })
  nodes = await nodesOf(user.id)

  const post = poster(user.id, () => nodes)
  await post("Opening Balance", "Bank", 100_000, "2026-01-01")
  await post("Card", "Opening Balance Contra", 20_000, "2026-01-02")
  for (const day of ["2026-01-05", "2026-02-05", "2026-03-05"]) await post("Salary", "Bank", 50_000, day)
  await post("Bank", "Groceries", 4_000, "2026-01-10")
  await post("Bank", "Food", 1_000, "2026-01-12")
  await post("Bank", "Dining", 1_500, "2026-01-15")
  for (const day of ["2026-01-20", "2026-02-20", "2026-03-08"]) await post("Bank", "Rent", 15_000, day)
  await post("Bank", "Card", 5_000, "2026-01-25")
  await post("Interest", "Bank", 300, "2026-02-07")
  await post("Card", "Groceries", 2_500, "2026-02-10")
  await post("Groceries", "Bank", 500, "2026-02-12")
  await post("Bank", "Savings", 10_000, "2026-02-18")
  await post("Bank", "Dining", 6_000, "2026-03-09")
  await post("Dining", "Bank", 9_000, "2026-03-12")
  await post("Realised Gain", "Bank", 2_000, "2026-03-15")
  await post("Bank", "Realised Loss", 800, "2026-03-16")
  const deleted = await post("Bank", "Groceries", 99_999, "2026-03-20")
  await softDeleteTransaction(user.id, deleted.id)

  return { user, nodes }
}

/** Scenario N: a bank and a card, gold bought in two lots and part-sold, a contribution-only fund, two prices. */
export async function holdingsScenario(registry: Registry): Promise<Scenario> {
  const user = await newUser(registry)
  await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS" })
  await createLedgerNode(user.id, { kind: "LIABILITY", name: "Card", liabilitySubtype: "CREDIT_CARD" })
  await createLedgerNode(user.id, { kind: "INVESTMENT", name: "Gold", valuationMode: "QUANTITY", unitLabel: "g", lotMethod: "FIFO" })
  await createLedgerNode(user.id, { kind: "INVESTMENT", name: "Fund", valuationMode: "CONTRIBUTION_ONLY", unitLabel: "unit" })
  const nodes = await nodesOf(user.id)

  const post = poster(user.id, () => nodes)
  await post("Opening Balance", "Bank", 200_000, "2026-01-02")
  await post("Card", "Opening Balance Contra", 20_000, "2026-01-02")
  await post("Bank", "Gold", 70_000, "2026-01-10", { quantity: 10n * QUANTITY_SCALE })
  await post("Bank", "Fund", 10_000, "2026-01-20")
  await post("Bank", "Gold", 37_000, "2026-02-10", { quantity: 5n * QUANTITY_SCALE })
  await recordPrice(user.id, { nodeId: nodes.Gold.id, asOf: calendarDate("2026-02-15"), pricePerUnit: rupees(7_500) })
  await recordPrice(user.id, { nodeId: nodes.Gold.id, asOf: calendarDate("2026-03-05"), pricePerUnit: rupees(7_600) })
  await sellInvestment(user.id, {
    nodeId: nodes.Gold.id,
    toNodeId: nodes.Bank.id,
    quantity: 8n * QUANTITY_SCALE,
    proceeds: rupees(60_800),
    occurredAt: calendarDate("2026-03-05"),
    idempotencyKey: randomUUID(),
  })

  return { user, nodes }
}
