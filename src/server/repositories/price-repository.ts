import { Prisma } from "@prisma/client"
import { fromDbDate, toDbDate, type CalendarDate } from "@/domain/calendar-date"
import type { Paise } from "@/domain/money"
import type { PricePoint } from "@/domain/valuation"
import { prisma } from "@/server/db"
import { NotFoundError } from "./errors"
import { assertNodesOwned } from "./node-repository"
import { clientOf, type UnitOfWork } from "./unit-of-work"

// The only code that reads or writes PriceSnapshot rows. Every exported function takes `userId` first and puts it in the
// `where` of every query. A snapshot's userId is not tied to its node's owner by the schema, so a write first checks
// that the node is the caller's. Only MANUAL prices are written in M2; FEED is the seam for a future price feed.

/**
 * Set the price of one unit of the node on a day. A day that already has a price is overwritten (EC-26): the unique
 * (nodeId, asOf) pair means one price a day. Throws NotFoundError, writing nothing, if the node is not this user's.
 */
export async function upsertPrice(
  userId: string,
  data: { nodeId: string; asOf: CalendarDate; pricePerUnitPaise: Paise },
): Promise<void> {
  const asOf = toDbDate(data.asOf)
  const write = () =>
    prisma.$transaction(async (tx) => {
      await assertNodesOwned(userId, [data.nodeId], tx)
      await tx.priceSnapshot.upsert({
        where: { nodeId_asOf: { nodeId: data.nodeId, asOf }, userId },
        create: { userId, nodeId: data.nodeId, asOf, pricePerUnitPaise: data.pricePerUnitPaise, source: "MANUAL" },
        update: { pricePerUnitPaise: data.pricePerUnitPaise, source: "MANUAL" },
      })
    })
  try {
    await write()
  } catch (error) {
    // Two writes of the same day racing: both found no row and the second create lost to the first. The row exists now,
    // so writing again overwrites it, which is what the later write means (EC-26).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") await write()
    else throw error
  }
}

/** Every price of the node, oldest day first. Empty for a node with none, or another user's. */
export async function listPrices(userId: string, nodeId: string): Promise<PricePoint[]> {
  const rows = await prisma.priceSnapshot.findMany({
    where: { userId, nodeId },
    orderBy: { asOf: "asc" },
    select: { asOf: true, pricePerUnitPaise: true },
  })
  return rows.map((row) => ({ asOf: fromDbDate(row.asOf), pricePerUnitPaise: row.pricePerUnitPaise }))
}

/** Delete the node's price for one day. Throws NotFoundError if this user has no price for that node on that day. */
export async function deletePrice(userId: string, nodeId: string, asOf: CalendarDate): Promise<void> {
  const { count } = await prisma.priceSnapshot.deleteMany({ where: { userId, nodeId, asOf: toDbDate(asOf) } })
  if (count === 0) throw new NotFoundError("price")
}

/**
 * Delete every price of the node, inside the caller's transaction: what removing a node with no transactions takes with
 * it (a snapshot's foreign key to its node is RESTRICT). Deletes nothing for another user's node.
 */
export async function deletePricesOfNode(userId: string, nodeId: string, uow: UnitOfWork): Promise<void> {
  await clientOf(uow).priceSnapshot.deleteMany({ where: { userId, nodeId } })
}
