import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { calendarDate, todayIn } from "@/domain/calendar-date"
import { buildDashboard } from "@/lib/dashboard-view"
import { prisma } from "@/server/db"
import { getDashboard } from "@/server/services/balance-service"
import { seedAccountNodes } from "@/server/services/account-seed"
import { archiveLedgerNode, createLedgerNode } from "@/server/services/node-service"
import { recordTransaction } from "@/server/services/transaction-service"
import { createRegistry } from "./repositories/fixtures"

// The dashboard's data, from real rows. Every expected figure is a literal worked out by hand (paise), never computed
// with the code under test.

const registry = createRegistry()
afterAll(registry.cleanup)

async function newUser() {
  const user = await registry.makeUser()
  await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
  return user
}

const named = (userId: string, name: string) => prisma.ledgerNode.findFirstOrThrow({ where: { userId, name } })

async function post(userId: string, from: string, to: string, amount: bigint, occurredAt: string, note?: string) {
  return recordTransaction(userId, {
    fromNodeId: (await named(userId, from)).id,
    toNodeId: (await named(userId, to)).id,
    amount,
    occurredAt: calendarDate(occurredAt),
    note,
    idempotencyKey: randomUUID(),
  })
}

/** Today in the zone a freshly made user has: the one the dashboard will use. */
async function todayOf(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  return todayIn(user.timezone)
}

/** Every value in the object, so a bigint anywhere in it is found. */
function typesIn(value: unknown): Set<string> {
  const found = new Set<string>([typeof value])
  if (value !== null && typeof value === "object") for (const inner of Object.values(value)) typesIn(inner).forEach((t) => found.add(t))
  return found
}

describe("getDashboard", () => {
  it("computes net worth across assets, investments and liabilities", async () => {
    const user = await newUser()
    await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS", openingBalance: 5_000_000n })
    await createLedgerNode(user.id, { kind: "INVESTMENT", name: "Fund", valuationMode: "CONTRIBUTION_ONLY", unitLabel: "unit" })
    await createLedgerNode(user.id, { kind: "LIABILITY", name: "Card", liabilitySubtype: "CREDIT_CARD", openingBalance: -1_200_000n })
    const today = await todayOf(user.id)
    await post(user.id, "Bank", "Fund", 1_000_000n, today)

    const view = await getDashboard(user.id)

    // Bank 50,000 - 10,000 = 40,000; fund 10,000; card owes 12,000. 40,000 + 10,000 - 12,000 = 38,000 rupees.
    expect(view.netWorth).toMatchObject({
      assets: "4000000",
      investments: "1000000",
      liabilities: "1200000",
      total: "3800000",
      isPartial: false,
      unvaluedNodeIds: [],
    })
  })

  it("lists the live holdings with their signed balances: a card you owe on is negative, and is not negated twice", async () => {
    const user = await newUser()
    await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS", openingBalance: 100_000n })
    await createLedgerNode(user.id, { kind: "LIABILITY", name: "Card", liabilitySubtype: "CREDIT_CARD", openingBalance: -124_975n })

    const view = await getDashboard(user.id)

    expect(view.accounts).toEqual([
      expect.objectContaining({ name: "Bank", kind: "ASSET", balance: "100000" }),
      expect.objectContaining({ name: "Card", kind: "LIABILITY", balance: "-124975" }),
    ])
    expect(view.netWorth.liabilities).toBe("124975") // the positive magnitude owed
    expect(view.netWorth.total).toBe("-24975") // 1,000.00 held less 1,249.75 owed
  })

  it("excludes future-dated transactions from the current figure and reports them as projected", async () => {
    const user = await newUser()
    await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS", openingBalance: 5_000_000n })
    await post(user.id, "Bank", "Rent", 3_000_000n, "2099-03-01")
    await post(user.id, "Bank", "Groceries", 100_000n, "2099-06-15")

    const view = await getDashboard(user.id)

    expect(view.netWorth.total).toBe("5000000") // neither is today's
    expect(view.accounts.find((a) => a.name === "Bank")?.balance).toBe("5000000")
    // 50,000 - 30,000 - 1,000 = 19,000 rupees, as of the last future-dated entry.
    expect(view.projected).toEqual({ total: "1900000", asOf: "2099-06-15", isPartial: false })
  })

  it("has nothing projected when no transaction is dated after today", async () => {
    const user = await newUser()
    await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS", openingBalance: 5_000_000n })
    await post(user.id, "Bank", "Rent", 1_000n, await todayOf(user.id))
    expect((await getDashboard(user.id)).projected).toBeNull()
  })

  it("still reports a projection that moves money between accounts and leaves the total where it was", async () => {
    const user = await newUser()
    await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS", openingBalance: 5_000_000n })
    await createLedgerNode(user.id, { kind: "ASSET", name: "Wallet", assetSubtype: "CASH" })
    await post(user.id, "Bank", "Wallet", 200_000n, "2099-01-01") // between two accounts: net worth is the same either side
    expect((await getDashboard(user.id)).projected).toEqual({ total: "5000000", asOf: "2099-01-01", isPartial: false })
  })

  it("returns a coherent empty state for a brand-new account", async () => {
    const user = await newUser()
    const view = await getDashboard(user.id)

    expect(view.isEmpty).toBe(true)
    expect(view.accounts).toEqual([]) // the system nodes and starter expense ledgers are not accounts
    expect(view.recent).toEqual([])
    expect(view.projected).toBeNull()
    expect(view.netWorth).toEqual({
      assets: "0",
      investments: "0",
      liabilities: "0",
      total: "0",
      isPartial: false,
      unvaluedNodeIds: [],
      unvaluedNames: [],
      staleNames: [],
      archivedCount: 0,
    })
  })

  it("treats an investment with no valuation as a contribution balance in M1", async () => {
    const user = await newUser()
    await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS", openingBalance: 2_000_000n })
    await createLedgerNode(user.id, { kind: "INVESTMENT", name: "Fund", valuationMode: "CONTRIBUTION_ONLY", unitLabel: "unit" })
    await post(user.id, "Bank", "Fund", 750_000n, await todayOf(user.id))

    const view = await getDashboard(user.id)

    expect(view.netWorth).toMatchObject({ investments: "750000", total: "2000000", isPartial: false })
  })

  it("renders every amount as a string", async () => {
    const user = await newUser()
    await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS" })
    await post(user.id, "Opening Balance", "Bank", 5_000_000n, "2020-01-01")
    await post(user.id, "Bank", "Rent", 300_000n, await todayOf(user.id), "rent")
    await post(user.id, "Bank", "Groceries", 100_000n, "2099-01-01")

    const view = await getDashboard(user.id)

    expect(() => JSON.stringify(view)).not.toThrow()
    expect(typesIn(view)).not.toContain("bigint")
    for (const text of [view.netWorth.total, view.netWorth.assets, view.netWorth.investments, view.netWorth.liabilities]) {
      expect(typeof text).toBe("string")
    }
    expect(view.recent[0]?.amountPaise).toBe("300000")
  })

  it("counts an archived card in net worth while hiding it from the list", async () => {
    const user = await newUser()
    await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS", openingBalance: 5_000_000n })
    const card = await createLedgerNode(user.id, {
      kind: "LIABILITY",
      name: "Old card",
      liabilitySubtype: "CREDIT_CARD",
      openingBalance: -1_200_000n,
    })
    const before = await getDashboard(user.id)
    await archiveLedgerNode(user.id, card.id)
    const after = await getDashboard(user.id)

    expect(after.accounts.map((a) => a.name)).toEqual(["Bank"]) // hidden from the list ...
    expect(after.netWorth).toEqual({ ...before.netWorth, archivedCount: 1 }) // ... but the debt is still owed
    expect(after.netWorth.total).toBe("3800000")
    expect(after.kindTotals.find((k) => k.kind === "LIABILITY")).toEqual({ kind: "LIABILITY", total: "-1200000", archivedCount: 1 })
    expect(after.isEmpty).toBe(false)
  })

  it("lists the ten most recent transactions up to today, newest first, with account names", async () => {
    const user = await newUser()
    await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS" })
    await post(user.id, "Opening Balance", "Bank", 9_000_000n, "2020-01-01") // long ago: outside the window
    const today = await todayOf(user.id)
    for (let n = 1; n <= 12; n += 1) await post(user.id, "Bank", "Groceries", BigInt(n) * 100n, today, `entry ${n}`)
    await post(user.id, "Bank", "Rent", 1_000n, "2099-01-01", "future")

    const view = await getDashboard(user.id)

    expect(view.recent).toHaveLength(10)
    expect(view.recent.every((r) => r.occurredAt === today)).toBe(true)
    expect(view.recent.map((r) => r.note)).not.toContain("future")
    expect(view.recent[0]).toMatchObject({ fromName: "Bank", toName: "Groceries" })
    expect(new Set(view.recent.map((r) => r.note)).size).toBe(10)
  })

  it("does not see another user's accounts", async () => {
    const mine = await newUser()
    const theirs = await newUser()
    await createLedgerNode(theirs.id, { kind: "ASSET", name: "Not mine", assetSubtype: "SAVINGS", openingBalance: 100n })
    const view = await getDashboard(mine.id)
    expect(view.accounts).toEqual([])
    expect(view.netWorth.total).toBe("0")
  })
})

describe("buildDashboard", () => {
  it("reports an investment that cannot be valued as a partial figure, by name, instead of dropping it silently", async () => {
    const user = await newUser()
    const bank = await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS", openingBalance: 2_000_000n })
    const fund = await createLedgerNode(user.id, { kind: "INVESTMENT", name: "Unpriced fund", valuationMode: "CONTRIBUTION_ONLY", unitLabel: "unit" })
    await post(user.id, "Bank", "Unpriced fund", 750_000n, await todayOf(user.id))
    const nodes = await prisma.ledgerNode.findMany({ where: { userId: user.id } })
    const balances = [
      { nodeId: bank.id, kind: "ASSET" as const, balance: 1_250_000n, archived: false },
      { nodeId: fund.id, kind: "INVESTMENT" as const, balance: 750_000n, archived: false },
    ]

    const view = buildDashboard({
      nodes,
      current: balances,
      all: balances,
      recent: [],
      latestDate: null,
      valuations: new Map([[fund.id, null]]),
    })

    // The fund is out of the total (12,500 rupees is only what the bank holds) and the view says why.
    expect(view.netWorth).toMatchObject({
      total: "1250000",
      investments: "0",
      isPartial: true,
      unvaluedNodeIds: [fund.id],
      unvaluedNames: ["Unpriced fund"],
    })
  })
})
