import { randomUUID } from "node:crypto"
import type { LedgerKind } from "@prisma/client"
import { calendarDate, toDbDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"

// Shared setup for the repository tests. Rows are created straight through Prisma, not through the repositories under
// test, so an assertion about "this row is unchanged" compares against a state the repository never touched.
// Each test file makes its own registry and calls `cleanup` in afterAll, so repeated runs leave nothing behind.

export function createRegistry() {
  const userIds: string[] = []

  async function makeUser() {
    const user = await prisma.user.create({
      data: { email: `${randomUUID()}@repo.test`, passwordHash: "not-a-real-hash" },
    })
    userIds.push(user.id)
    return user
  }

  async function makeNode(userId: string, kind: LedgerKind, name: string) {
    return prisma.ledgerNode.create({ data: { userId, kind, name } })
  }

  async function makeTransaction(
    userId: string,
    fromNodeId: string,
    toNodeId: string,
    over: { amountPaise?: bigint; occurredAt?: string; note?: string; tags?: string[]; deletedAt?: Date } = {},
  ) {
    return prisma.transaction.create({
      data: {
        userId,
        fromNodeId,
        toNodeId,
        amountPaise: over.amountPaise ?? 1_000n,
        occurredAt: toDbDate(calendarDate(over.occurredAt ?? "2026-04-01")),
        note: over.note,
        tags: over.tags,
        deletedAt: over.deletedAt,
      },
    })
  }

  /** A user with an income source, a bank account and an expense node, and one live transaction bank -> expense. */
  async function makeWorld() {
    const user = await makeUser()
    const income = await makeNode(user.id, "INCOME_SOURCE", "Salary")
    const bank = await makeNode(user.id, "ASSET", "Bank")
    const food = await makeNode(user.id, "EXPENSE", "Food")
    const tx = await makeTransaction(user.id, bank.id, food.id, { amountPaise: 500n, note: "lunch" })
    const group = await prisma.transactionGroup.create({ data: { userId: user.id, kind: "MANUAL_SPLIT" } })
    return { user, income, bank, food, tx, group }
  }

  async function cleanup() {
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.transactionGroup.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.ledgerNode.deleteMany({ where: { userId: { in: userIds }, parentId: { not: null } } })
    await prisma.ledgerNode.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.$disconnect()
  }

  return { makeUser, makeNode, makeTransaction, makeWorld, cleanup }
}
