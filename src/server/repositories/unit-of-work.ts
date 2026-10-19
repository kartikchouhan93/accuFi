import type { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"

/**
 * Run `work` in one database transaction: everything written through the client it receives commits together, or
 * not at all if `work` throws. A service that must change two tables atomically (a node and its opening-balance
 * transaction) opens the transaction here and hands the client to the repositories (`createNode(..., tx)`,
 * `insertTransactions(..., tx)`), which keep their ownership checks and their `userId` scoping. The client is only
 * ever passed back into a repository; services never query with it, which keeps this layer the only code that does.
 */
export function inTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(work)
}
