import type { Prisma } from "@prisma/client"
import { prisma } from "@/server/db"

declare const unitOfWork: unique symbol

/**
 * An open database transaction, as an opaque token. A service that must change two tables atomically (a node and its
 * opening-balance transaction) gets one from `inTransaction` and can do exactly one thing with it: pass it on to a
 * repository function (`createNode(..., uow)`, `insertTransactions(..., uow)`), which keeps its ownership checks and
 * its `userId` scoping. The token has no Prisma surface, so `uow.ledgerNode.findMany({})` is a compile error rather
 * than something a reviewer has to spot; it needs no `@prisma/client` import either, which is what would otherwise
 * make the boundary violation invisible to a grep.
 */
export interface UnitOfWork {
  readonly [unitOfWork]: true
}

// The client lives here, keyed by the token, not on it: there is nothing to reach through a cast at runtime either.
const clients = new WeakMap<object, Prisma.TransactionClient>()

/**
 * Run `work` in one database transaction: everything written through repositories with the token it receives commits
 * together, or not at all if `work` throws.
 */
export function inTransaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
  return prisma.$transaction((tx) => {
    const uow = Object.freeze({}) as UnitOfWork
    clients.set(uow, tx)
    return work(uow)
  })
}

/** For repositories only: the client behind a token. Services pass the token on and never call this. */
export function clientOf(uow: UnitOfWork): Prisma.TransactionClient {
  const client = clients.get(uow)
  if (!client) throw new Error("Not a UnitOfWork issued by inTransaction")
  return client
}
