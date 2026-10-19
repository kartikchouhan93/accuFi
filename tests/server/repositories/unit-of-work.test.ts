import { afterAll, describe, expect, it } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { createNode, findNodeById } from "@/server/repositories/node-repository"
import { insertTransactions } from "@/server/repositories/transaction-repository"
import { inTransaction } from "@/server/repositories/unit-of-work"
import { createRegistry } from "./fixtures"

const registry = createRegistry()
afterAll(registry.cleanup)

class Abort extends Error {}

describe("inTransaction", () => {
  it("commits what createNode and insertTransactions wrote together", async () => {
    const user = await registry.makeUser()
    const salary = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
    const { node, rows } = await inTransaction(async (tx) => {
      const node = await createNode(user.id, { kind: "ASSET", name: "Bank" }, tx)
      const rows = await insertTransactions(
        user.id,
        [{ fromNodeId: salary.id, toNodeId: node.id, amountPaise: 100n, occurredAt: calendarDate("2026-04-01") }],
        undefined,
        tx,
      )
      return { node, rows }
    })
    expect(await findNodeById(user.id, node.id)).not.toBeNull()
    expect(await prisma.transaction.findUnique({ where: { id: rows[0].id } })).not.toBeNull()
  })

  it("rolls back both writes when the callback throws after them", async () => {
    const user = await registry.makeUser()
    const salary = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
    let nodeId = ""
    await expect(
      inTransaction(async (tx) => {
        const node = await createNode(user.id, { kind: "ASSET", name: "Bank" }, tx)
        nodeId = node.id
        await insertTransactions(
          user.id,
          [{ fromNodeId: salary.id, toNodeId: node.id, amountPaise: 100n, occurredAt: calendarDate("2026-04-01") }],
          undefined,
          tx,
        )
        throw new Abort()
      }),
    ).rejects.toThrow(Abort)
    expect(nodeId).not.toBe("")
    expect(await findNodeById(user.id, nodeId)).toBeNull()
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(0)
  })

  it("keeps the ownership checks when a transaction client is passed", async () => {
    const mine = await registry.makeUser()
    const theirs = await registry.makeUser()
    const theirNode = await registry.makeNode(theirs.id, "EXPENSE", "Food")
    const myNode = await registry.makeNode(mine.id, "ASSET", "Bank")
    await expect(
      inTransaction((tx) => createNode(mine.id, { kind: "EXPENSE", name: "Lunch", parentId: theirNode.id }, tx)),
    ).rejects.toThrow(NotFoundError)
    await expect(
      inTransaction((tx) =>
        insertTransactions(
          mine.id,
          [{ fromNodeId: myNode.id, toNodeId: theirNode.id, amountPaise: 100n, occurredAt: calendarDate("2026-04-01") }],
          undefined,
          tx,
        ),
      ),
    ).rejects.toThrow(NotFoundError)
    expect(await prisma.transaction.count({ where: { userId: mine.id } })).toBe(0)
  })
})
