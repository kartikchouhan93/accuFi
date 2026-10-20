import { afterAll, describe, expect, it } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { createRegistry } from "./fixtures"

const registry = createRegistry()
afterAll(registry.cleanup)

async function setup() {
  const user = await registry.makeUser()
  const salary = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  const balanceOf = async (nodeId: string, asOf?: string) => {
    const rows = await sumBalances(user.id, asOf === undefined ? undefined : calendarDate(asOf))
    return rows.find((r) => r.nodeId === nodeId)
  }
  return { user, salary, bank, food, balanceOf }
}

describe("sumBalances", () => {
  it("computes a balance as inflows minus outflows", async () => {
    const { user, salary, bank, food, balanceOf } = await setup()
    await registry.makeTransaction(user.id, salary.id, bank.id, { amountPaise: 100_000n })
    await registry.makeTransaction(user.id, bank.id, food.id, { amountPaise: 25_050n })
    expect((await balanceOf(bank.id))?.balance).toBe(74_950n)
    expect((await balanceOf(food.id))?.balance).toBe(25_050n)
    expect((await balanceOf(salary.id))?.balance).toBe(-100_000n)
  })

  it("reports each node's kind", async () => {
    const { salary, bank, food, balanceOf } = await setup()
    expect((await balanceOf(salary.id))?.kind).toBe("INCOME_SOURCE")
    expect((await balanceOf(bank.id))?.kind).toBe("ASSET")
    expect((await balanceOf(food.id))?.kind).toBe("EXPENSE")
  })

  it("excludes soft-deleted transactions", async () => {
    const { user, salary, bank, balanceOf } = await setup()
    await registry.makeTransaction(user.id, salary.id, bank.id, { amountPaise: 700n })
    await registry.makeTransaction(user.id, salary.id, bank.id, { amountPaise: 300n, deletedAt: new Date() })
    expect((await balanceOf(bank.id))?.balance).toBe(700n)
    expect((await balanceOf(salary.id))?.balance).toBe(-700n)
  })

  it("excludes transactions after the asOf date", async () => {
    // EC-10: a current figure bounded at today, and a projected one that includes future-dated rows.
    const { user, salary, bank, balanceOf } = await setup()
    await registry.makeTransaction(user.id, salary.id, bank.id, { amountPaise: 100n, occurredAt: "2026-04-01" })
    await registry.makeTransaction(user.id, salary.id, bank.id, { amountPaise: 20n, occurredAt: "2026-04-15" })
    await registry.makeTransaction(user.id, salary.id, bank.id, { amountPaise: 3n, occurredAt: "2026-05-01" })
    expect((await balanceOf(bank.id, "2026-03-31"))?.balance).toBe(0n)
    expect((await balanceOf(bank.id, "2026-04-01"))?.balance).toBe(100n) // the asOf day itself is included
    expect((await balanceOf(bank.id, "2026-04-14"))?.balance).toBe(100n)
    expect((await balanceOf(bank.id, "2026-04-15"))?.balance).toBe(120n)
    expect((await balanceOf(bank.id))?.balance).toBe(123n) // no asOf: unbounded, the future rows count
  })

  it("returns a zero balance for a node with no transactions", async () => {
    const { bank, food, user, salary, balanceOf } = await setup()
    expect(await balanceOf(bank.id)).toEqual({ nodeId: bank.id, kind: "ASSET", balance: 0n, archived: false })
    // Also when other nodes have activity, and when the only rows are after asOf or deleted.
    await registry.makeTransaction(user.id, salary.id, food.id, { amountPaise: 5n, occurredAt: "2026-06-01" })
    expect((await balanceOf(bank.id, "2026-01-01"))?.balance).toBe(0n)
    expect((await balanceOf(food.id, "2026-01-01"))?.balance).toBe(0n)
    expect((await sumBalances(user.id)).map((r) => r.nodeId).sort()).toEqual([salary.id, bank.id, food.id].sort())
  })

  it("includes archived nodes, flagged, with their balance intact", async () => {
    // EC-32: an archived node still holds its balance, and net worth must still count it. Hiding it from lists is a
    // display concern for the caller, which is what the flag is for.
    const { user, salary, bank, food, balanceOf } = await setup()
    await registry.makeTransaction(user.id, salary.id, bank.id, { amountPaise: 900n })
    await registry.makeTransaction(user.id, bank.id, food.id, { amountPaise: 200n })
    await prisma.ledgerNode.update({ where: { id: bank.id }, data: { archivedAt: new Date() } })
    expect(await balanceOf(bank.id)).toEqual({ nodeId: bank.id, kind: "ASSET", balance: 700n, archived: true })
    expect((await balanceOf(food.id))?.archived).toBe(false)
    expect((await sumBalances(user.id)).map((r) => r.nodeId).sort()).toEqual([salary.id, bank.id, food.id].sort())
  })

  it("sums amounts above Number.MAX_SAFE_INTEGER without precision loss", async () => {
    const { user, salary, bank, balanceOf } = await setup()
    const unsafe = BigInt(Number.MAX_SAFE_INTEGER) + 2n // 9007199254740993: not representable as a JS number
    expect(BigInt(Number(unsafe))).not.toBe(unsafe)
    await registry.makeTransaction(user.id, salary.id, bank.id, { amountPaise: unsafe })
    expect((await balanceOf(bank.id))?.balance).toBe(unsafe)
    // The sum itself can exceed what one bigint column holds (int8 max is 9223372036854775807).
    const near = 9_000_000_000_000_000_001n
    await registry.makeTransaction(user.id, salary.id, bank.id, { amountPaise: near })
    await registry.makeTransaction(user.id, salary.id, bank.id, { amountPaise: near })
    const expected = unsafe + near + near
    expect(expected).toBeGreaterThan(9_223_372_036_854_775_807n)
    expect((await balanceOf(bank.id))?.balance).toBe(expected)
    expect((await balanceOf(salary.id))?.balance).toBe(-expected)
  })
})
