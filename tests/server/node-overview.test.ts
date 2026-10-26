import { afterAll, describe, expect, it } from "vitest"
import { seedAccountNodes } from "@/server/services/account-seed"
import { archiveLedgerNode, createLedgerNode } from "@/server/services/node-service"
import { loadNodeOverview } from "@/server/services/node-overview"
import { prisma } from "@/server/db"
import { createRegistry } from "./repositories/fixtures"

// The ledger screen's data, from real rows: an archived node is still in the figures, and the whole thing survives the
// trip to the browser.

const registry = createRegistry()
afterAll(registry.cleanup)

describe("loadNodeOverview", () => {
  it("keeps an archived card's debt in net worth and in its kind's total, and lists the node", async () => {
    const user = await registry.makeUser()
    await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
    const bank = await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS", openingBalance: 5_000_000n })
    const card = await createLedgerNode(user.id, {
      kind: "LIABILITY",
      name: "Card",
      liabilitySubtype: "CREDIT_CARD",
      openingBalance: -1_200_000n,
    })

    const before = await loadNodeOverview(user.id)
    expect(before.netWorth).toMatchObject({ total: "3800000", assets: "5000000", liabilities: "1200000" })

    await archiveLedgerNode(user.id, card.id)
    const after = await loadNodeOverview(user.id)

    // Archived, but not gone: the debt is still owed.
    expect(after.netWorth).toEqual(before.netWorth)
    expect(after.kinds.LIABILITY).toEqual({ total: "-1200000", archivedCount: 1, unvaluedCount: 0, archivedUnvaluedCount: 0 })
    expect(after.balances[card.id]).toBe("-1200000")
    expect(after.nodes.find((n) => n.id === card.id)?.archivedAt).not.toBeNull()
    expect(after.balances[bank.id]).toBe("5000000")
  })

  it("counts today's figures only: a future-dated transaction is not in the balance, the kind total or net worth (EC-10)", async () => {
    const user = await registry.makeUser()
    await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
    const bank = await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS", openingBalance: 5_000_000n })
    const rent = await prisma.ledgerNode.findFirstOrThrow({ where: { userId: user.id, name: "Rent" } })
    await registry.makeTransaction(user.id, bank.id, rent.id, { amountPaise: 3_000_000n, occurredAt: "2099-01-01" })

    const overview = await loadNodeOverview(user.id)
    expect(overview.balances[bank.id]).toBe("5000000")
    expect(overview.kinds.ASSET.total).toBe("5000000")
    expect(overview.netWorth.total).toBe("5000000")
  })

  it("is plain data and covers the seeded system nodes", async () => {
    const user = await registry.makeUser()
    await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
    const overview = await loadNodeOverview(user.id)
    expect(() => JSON.stringify(overview)).not.toThrow()
    expect(overview.nodes.filter((n) => n.systemRole !== null)).toHaveLength(4)
    expect(Object.keys(overview.balances)).toHaveLength(overview.nodes.length)
  })

  it("does not see another user's nodes", async () => {
    const mine = await registry.makeUser()
    const theirs = await registry.makeUser()
    await registry.makeNode(theirs.id, "ASSET", "Not mine")
    const overview = await loadNodeOverview(mine.id)
    expect(overview.nodes.map((n) => n.name)).not.toContain("Not mine")
  })
})
