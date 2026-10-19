import type { Prisma } from "@prisma/client"
import type { LedgerKind, SystemNodeRole } from "@/domain/ledger-kind"

// The nodes every account starts with. Typed on the domain unions, so adding a system role without deciding its
// name and kind here is a compile error.
//
// OPENING_BALANCE and REALISED_GAIN are INCOME_SOURCE (money comes *from* them into the ledger); REALISED_LOSS is
// EXPENSE (money goes *to* it). Disposals and opening balances rely on exactly these kinds.
const SYSTEM_NODES: Record<SystemNodeRole, { name: string; kind: LedgerKind }> = {
  OPENING_BALANCE: { name: "Opening Balance", kind: "INCOME_SOURCE" },
  REALISED_GAIN: { name: "Realised Gain", kind: "INCOME_SOURCE" },
  REALISED_LOSS: { name: "Realised Loss", kind: "EXPENSE" },
}

// Ordinary expense ledgers, systemRole null: the user may rename, archive or delete them.
const STARTER_EXPENSE_LEDGERS = ["Groceries", "Rent", "Utilities", "Transport", "Dining", "Health"] as const

/**
 * Create the system nodes and starter ledgers for a user that was just created. Takes the transaction client, not
 * the global one, so the caller decides the atomic boundary: a failure here must roll the user back with it.
 */
export async function seedAccountNodes(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const system = (Object.entries(SYSTEM_NODES) as [SystemNodeRole, { name: string; kind: LedgerKind }][]).map(
    ([systemRole, { name, kind }]) => ({ userId, kind, name, systemRole }),
  )
  const starters = STARTER_EXPENSE_LEDGERS.map((name) => ({ userId, kind: "EXPENSE" as const, name }))
  await tx.ledgerNode.createMany({ data: [...system, ...starters] })
}
