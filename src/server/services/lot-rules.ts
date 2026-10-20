import type { LedgerNode, Transaction } from "@prisma/client"
import { compareDates, fromDbDate, type CalendarDate } from "@/domain/calendar-date"
import { InsufficientQuantityError } from "@/domain/lots"
import { formatPaise, type Paise } from "@/domain/money"
import { formatQuantity, QUANTITY_SCALE, type Quantity } from "@/domain/quantity"
import type { HoldingLot } from "@/domain/valuation"
import {
  countConsumptionsOfLot,
  deleteLotOf,
  findConsumptionsByTransaction,
  findLiveLots,
  findLotByTransaction,
  insertLot,
  lockHoldings,
  updateLot,
} from "@/server/repositories/lot-repository"
import { NotFoundError } from "@/server/repositories/errors"
import { findNodeById } from "@/server/repositories/node-repository"
import { findGroupById } from "@/server/repositories/transaction-repository"
import type { UnitOfWork } from "@/server/repositories/unit-of-work"
import { InvalidTransactionError, LotInUseError, type LotRuleCode, type TransactionViolation } from "./transaction-errors"

// The lot rules of the write path (spec §7.2, plan calls 1, 3, 5, 7), shared by the transaction service and the sale
// path. A purchase into an investment valued by quantity (QUANTITY) or as a lump (LUMP) creates exactly one lot, in the
// same database transaction as the row: its quantity is what was bought (a lump is always 1 unit), its cost basis the
// amount, its day the transaction's. A lump investment holds one live lot at most: a lump price values the whole asset,
// so a second purchase would be valued twice; it is refused on create, on edit and on restore. The lot follows the
// row: an edit of the amount, quantity or day updates it in lockstep (EC-15), moving the row out of a lot-mode
// investment deletes it (EC-16), and deleting or restoring the row takes it out of or back into every holding with no
// write at all (a lot is live while its buying transaction is; nothing remaining is stored). What a sale took is the
// one thing an edit or a delete must not undercut, so: an edit may not leave a lot holding less than its live sales
// took, costing less than they took, or dated after the first of them; a purchase a live sale took from cannot be
// deleted or moved ("delete the sale first"), nor moved while a deleted sale's rows still point at its lot. Money
// leaves a lot-mode investment only through a sale, which has its own write path, never through the generic writes,
// so the lots cannot drift from the ledger: that rules out a redemption, a fee and a switch between investments there,
// and a split leg into one (a split carries no quantity). A sale is never edited: it is deleted and entered again.
// An investment valued by contribution (CONTRIBUTION_ONLY) has no lots and keeps every flow it had (EC-28). Entries made
// before lots existed are left as they are until an edit supplies a quantity (call 7): nothing is guessed.

export type LotMode = "QUANTITY" | "LUMP"

/** How a node holds lots: by quantity, as a lump, or (null) not at all, which is every node but such an investment. */
export function lotModeOf(node: Pick<LedgerNode, "kind" | "valuationMode">): LotMode | null {
  if (node.kind !== "INVESTMENT") return null
  return node.valuationMode === "QUANTITY" || node.valuationMode === "LUMP" ? node.valuationMode : null
}

export const ONE_UNIT: Quantity = QUANTITY_SCALE
// Decimal(18,6): at most 12 digits before the point. The schema's parser enforces it too; this is for other callers.
export const QUANTITY_LIMIT: Quantity = 10n ** 18n

function refuse(code: LotRuleCode, message: string): never {
  throw new InvalidTransactionError(message, [{ code, message }])
}

export const lotSourceViolation = (from: LedgerNode): TransactionViolation => ({
  code: "LOT_SOURCE",
  message: `${from.name} is valued by its lots, so money leaves it only through a sale. Use Sell on the Investments screen.`,
})

/** A split carries no quantity, so a leg cannot buy into a lot-mode investment: that purchase is entered on its own. */
export const splitLegViolation = (destination: LedgerNode, index: number): TransactionViolation => ({
  code: "LOT_SPLIT_LEG",
  leg: index,
  message: `Leg ${index + 1}: ${destination.name} is valued by its lots, so record an investment purchase on its own.`,
})

/**
 * Money may leave a lot-mode investment only through a sale (call 3): through the generic path it would leave the lots
 * behind. A switch between investments with a lot-mode end is a sale (or a redemption) and then a purchase in M2.
 */
function lotFlowViolation(from: LedgerNode, to: LedgerNode): TransactionViolation | null {
  if (lotModeOf(from) !== null) {
    if (to.kind === "INVESTMENT") {
      return {
        code: "LOT_SWITCH",
        message: `Switching from ${from.name} to ${to.name} is a sale and then a purchase. Use Sell on the Investments screen, then buy ${to.name}.`,
      }
    }
    return lotSourceViolation(from)
  }
  if (from.kind === "INVESTMENT" && lotModeOf(to) !== null) {
    return {
      code: "LOT_SWITCH",
      message: `Switching from ${from.name} to ${to.name} is a redemption and then a purchase: record the redemption into an account, then buy ${to.name} from it.`,
    }
  }
  return null
}

export function assertNoLotFlow(from: LedgerNode, to: LedgerNode): void {
  const violation = lotFlowViolation(from, to)
  if (violation) throw new InvalidTransactionError(violation.message, [violation])
}

/** A quantity stated for a destination: refused where there are no lots, and held to what the database can store. */
function checkStatedQuantity(to: LedgerNode, quantity: Quantity | undefined): void {
  if (quantity === undefined) return
  if (lotModeOf(to) === null) refuse("QUANTITY_NOT_APPLICABLE", "Quantity applies only to investments valued by quantity.")
  if (quantity <= 0n || quantity >= QUANTITY_LIMIT) {
    refuse("QUANTITY_OUT_OF_RANGE", "Enter a quantity greater than zero, with at most 12 digits before the decimal point.")
  }
  if (lotModeOf(to) === "LUMP" && quantity !== ONE_UNIT) {
    refuse("LUMP_QUANTITY", `${to.name} is valued as one lump sum, so its quantity is always 1.`)
  }
}

/** The quantity a new purchase into `to` buys, or null if `to` holds no lots. Throws if it is missing or out of place. */
function purchaseQuantity(to: LedgerNode, quantity: Quantity | undefined): Quantity | null {
  checkStatedQuantity(to, quantity)
  const mode = lotModeOf(to)
  if (mode === "LUMP") return ONE_UNIT
  if (mode === "QUANTITY") {
    if (quantity === undefined) refuse("QUANTITY_REQUIRED", "Enter the quantity bought.")
    return quantity
  }
  return null
}

const lumpBoughtOnce = (node: LedgerNode): string =>
  `${node.name} is a lump investment, which is bought once. To add to it, create another investment.`

/** A lump investment holds one live lot: refuse a lot about to be added to `to` if it already holds one. */
async function assertLumpFree(userId: string, to: LedgerNode, uow: UnitOfWork): Promise<void> {
  if (lotModeOf(to) !== "LUMP") return
  if ((await findLiveLots(userId, to.id, uow)).length > 0) refuse("LUMP_ALREADY_BOUGHT", lumpBoughtOnce(to))
}

/** The node's unit as it follows a quantity: " g", or nothing for a node without one. */
export const unitOf = (node: LedgerNode): string => (node.unitLabel ? ` ${node.unitLabel}` : "")
const soldQuantity = (lot: HoldingLot): Quantity => lot.consumptions.reduce((sum, c) => sum + c.quantity, 0n)
const soldCost = (lot: HoldingLot): Paise => lot.consumptions.reduce((sum, c) => sum + c.costBasisPaise, 0n)
const alreadySold = (lot: HoldingLot, node: LedgerNode): string =>
  `Already sold: ${formatQuantity(soldQuantity(lot))} of the ${formatQuantity(lot.quantity)}${unitOf(node)}.`

/**
 * A lot can leave its investment (deleted, or moved to another) only if no sale takes from it. A deleted sale counts
 * too: its consumption rows still point at the lot (restoring the sale brings them back), and the database refuses to
 * delete a lot they reference. `node` is the investment the lot is in.
 */
export async function assertLotMovable(
  userId: string,
  transactionId: string,
  lot: HoldingLot,
  node: LedgerNode,
  uow: UnitOfWork,
): Promise<void> {
  if (lot.consumptions.length > 0) {
    const message = `${alreadySold(lot, node)} Delete the sale first, then move this purchase.`
    throw new LotInUseError(message, [{ code: "LOT_SOLD", message }])
  }
  if ((await countConsumptionsOfLot(userId, transactionId, uow)) > 0) {
    const message = `A deleted sale still takes from this purchase, so it cannot leave ${node.name}: restoring the sale needs it there. Delete this purchase and enter it again instead.`
    throw new LotInUseError(message, [{ code: "LOT_SOLD", message }])
  }
}

/**
 * What the live sales of a lot took must stay true of it after an edit (EC-15): it still holds at least as much as they
 * took, costs at least what they took (a remaining cost below zero is no cost at all), costs exactly that once they took
 * all of it (nothing is left to carry a difference), and was bought on or before the first of them (call 6). A deleted
 * sale is not counted; restoring it re-checks the lots.
 */
export function assertSalesStillCovered(
  lot: HoldingLot,
  node: LedgerNode,
  quantity: Quantity,
  amount: Paise,
  occurredAt: CalendarDate,
): void {
  if (lot.consumptions.length === 0) return
  const sold = soldQuantity(lot)
  const cost = soldCost(lot)
  const violations: TransactionViolation[] = []
  if (quantity < sold) {
    violations.push({
      code: "QUANTITY_BELOW_SOLD",
      message: `${alreadySold(lot, node).slice(0, -1)}, so the quantity cannot be less than ${formatQuantity(sold)}.`,
    })
  } else if (amount < cost) {
    violations.push({
      code: "AMOUNT_BELOW_SOLD",
      message: `Sales have already taken ${formatPaise(cost)} of this purchase's cost, so the amount cannot be less than that.`,
    })
  } else if (quantity === sold && amount !== cost) {
    violations.push({
      code: "SOLD_COST_CHANGED",
      message: `All of this purchase has been sold, so its amount must stay ${formatPaise(cost)}, the cost that went with the sales. Delete the sale first to change it.`,
    })
  }
  const firstSale = lot.consumptions.map((c) => c.disposedAt).reduce((a, b) => (compareDates(a, b) <= 0 ? a : b))
  if (compareDates(occurredAt, firstSale) > 0) {
    violations.push({
      code: "DATE_AFTER_SALE",
      message: `Part of this purchase was sold on ${firstSale}, so it cannot be dated after that.`,
    })
  }
  if (violations.length > 0) throw new InvalidTransactionError(violations.map((v) => v.message).join(" "), violations)
}

/** A sale is deleted and entered again, never edited (call 4): any leg of a disposal, or a row that consumed lots. */
export async function assertNotASale(userId: string, row: Transaction): Promise<void> {
  const group = row.groupId === null ? null : await findGroupById(userId, row.groupId)
  if (group?.kind === "DISPOSAL" || (await findConsumptionsByTransaction(userId, row.id)).length > 0) {
    throw new InvalidTransactionError("A sale is deleted and entered again, not edited.")
  }
}

export interface LotPurchase {
  from: LedgerNode
  to: LedgerNode
  /** The row just inserted for the purchase. */
  transactionId: string
  amount: Paise
  occurredAt: CalendarDate
  quantity: Quantity | undefined
}

/**
 * The lot rules of a new generic transaction, inside its database transaction after the row is inserted (so a replay,
 * which stops at the duplicate key, never reaches them): refuse money out of a lot-mode investment, check the quantity,
 * refuse a second lump, and write the lot. Throws, and the insert rolls back, if a rule refuses.
 */
export async function applyLotPurchase(userId: string, purchase: LotPurchase, uow: UnitOfWork): Promise<void> {
  const { from, to } = purchase
  assertNoLotFlow(from, to)
  const quantity = purchaseQuantity(to, purchase.quantity)
  if (quantity === null) return
  await assertLumpFree(userId, to, uow)
  await insertLot(
    userId,
    { nodeId: to.id, transactionId: purchase.transactionId, quantity, costBasisPaise: purchase.amount, acquiredAt: purchase.occurredAt },
    uow,
  )
}

export interface LotEdit {
  existing: Transaction
  /** The investment (or other node) the row pointed at before the edit, and after it. */
  oldTo: LedgerNode
  to: LedgerNode
  amount: Paise
  occurredAt: CalendarDate
  quantity: Quantity | undefined
}

/**
 * Bring the row's lot in line with the edited row, inside the edit's database transaction: create it, update it, move
 * it or delete it. Throws, and the edit rolls back, if a rule refuses. The lot of a row is always in the row's
 * destination, so `oldTo` is where it is now.
 */
export async function applyLotEdit(userId: string, edit: LotEdit, uow: UnitOfWork): Promise<void> {
  const { existing, oldTo, to } = edit
  const lot = await findLotByTransaction(userId, existing.id, uow)
  const moved = to.id !== existing.toNodeId
  const mode = lotModeOf(to)
  checkStatedQuantity(to, edit.quantity)

  if (mode === null) {
    if (lot) {
      await assertLotMovable(userId, existing.id, lot, oldTo, uow)
      await deleteLotOf(userId, existing.id, uow)
    }
    return
  }
  // A leg of a split never has a lot: it would need a quantity, and a split carries none.
  if (existing.groupId !== null && (moved || edit.quantity !== undefined)) {
    refuse(
      "LOT_SPLIT_LEG",
      `${to.name} is valued by its lots, so record an investment purchase on its own. Take this entry out of its split first.`,
    )
  }

  // The lot's quantity after the edit: the one stated; else a lump's one unit, or the quantity it already had in an
  // investment valued by quantity. Null leaves an entry from before lots existed as it was (call 7).
  let quantity: Quantity | null = edit.quantity ?? null
  if (quantity === null && mode === "LUMP" && (lot !== null || moved)) quantity = ONE_UNIT
  if (quantity === null && mode === "QUANTITY") {
    if (lot !== null && lotModeOf(oldTo) === "QUANTITY") quantity = lot.quantity
    else if (lot !== null || moved) refuse("QUANTITY_REQUIRED", "Enter the quantity bought.")
  }
  if (quantity === null) return

  // A lot arriving in `to`, new or moved from another investment; one already there is the lump's own.
  if (lot === null || moved) await assertLumpFree(userId, to, uow)
  if (lot === null) {
    await insertLot(userId, { nodeId: to.id, transactionId: existing.id, quantity, costBasisPaise: edit.amount, acquiredAt: edit.occurredAt }, uow)
    return
  }
  if (moved) await assertLotMovable(userId, existing.id, lot, oldTo, uow)
  assertSalesStillCovered(lot, oldTo, quantity, edit.amount, edit.occurredAt)
  await updateLot(
    userId,
    existing.id,
    { nodeId: moved ? to.id : undefined, quantity, costBasisPaise: edit.amount, acquiredAt: edit.occurredAt },
    uow,
  )
}

/**
 * Refuse to delete a purchase whose lot a live sale took from (EC-13): the sale would be left taking from a lot that no
 * longer counts. The lot itself stays (a deleted purchase's lot simply stops counting). `node` is the row's destination.
 */
export async function assertPurchaseRemovable(userId: string, row: Transaction, uow: UnitOfWork): Promise<void> {
  const lot = await findLotByTransaction(userId, row.id, uow)
  if (!lot || lot.consumptions.length === 0) return
  const node = await findNodeById(userId, row.toNodeId)
  throw new LotInUseError(`${node ? alreadySold(lot, node) : "Already sold."} Delete the sale first.`)
}

/**
 * A restored row's lot is live again: refuse it, inside the restore's database transaction, if that leaves a lump
 * investment holding two live lots. Call after the row is restored.
 */
export async function assertRestoredLotAllowed(userId: string, row: Transaction, uow: UnitOfWork): Promise<void> {
  const lot = await findLotByTransaction(userId, row.id, uow)
  if (!lot?.live) return
  const node = await findNodeById(userId, row.toNodeId)
  if (!node || lotModeOf(node) !== "LUMP") return
  if ((await findLiveLots(userId, node.id, uow)).length > 1) refuse("LUMP_ALREADY_BOUGHT", lumpBoughtOnce(node))
}

/**
 * A restored sale takes from its lots again: its consumption rows were kept (call 1), so nothing is re-allocated, and
 * what it took must still be there. While the sale was deleted nothing protected that: its purchase could be deleted or
 * edited, and another sale could take the same units. So, inside the restore's database transaction and after the row
 * is restored, each lot it took from must be live (its purchase not deleted), acquired on or before the sale (call 6),
 * and hold what the live sales now take with it, cost at least what they take, and cost exactly that if they take all of
 * it: what assertSalesStillCovered asks of an edit. Throws InsufficientQuantityError when the units are not there and
 * LotInUseError when the cost no longer fits, so the restore rolls back. Does nothing for a row that took from no lot.
 */
export async function assertRestoredSaleCovered(userId: string, row: Transaction, uow: UnitOfWork): Promise<void> {
  const taken = await findConsumptionsByTransaction(userId, row.id, uow)
  if (taken.length === 0) return
  // A lot taken from never leaves its investment (assertLotMovable), so every one is in the sale's source node.
  await lockHoldings(userId, row.fromNodeId, uow)
  const node = await findNodeById(userId, row.fromNodeId)
  if (!node) throw new NotFoundError("node")
  const lots = new Map((await findLiveLots(userId, node.id, uow)).map((lot) => [lot.id, lot]))
  const saleDate = fromDbDate(row.occurredAt)
  const refused = (reason: string): string => `This sale cannot be restored: ${reason}`
  const units = (quantity: Quantity): string => `${formatQuantity(quantity)}${unitOf(node)}`

  for (const consumption of taken) {
    const lot = lots.get(consumption.lotId)
    const took = `${units(consumption.quantity)} of ${node.name}`
    if (!lot) {
      const message = refused(`the purchase it took ${took} from has been deleted. Restore that purchase first.`)
      throw new InsufficientQuantityError(0n, consumption.quantity, message)
    }
    if (compareDates(lot.acquiredAt, saleDate) > 0) {
      const message = refused(`the purchase it took ${took} from is now dated ${lot.acquiredAt}, after this sale on ${saleDate}.`)
      throw new InsufficientQuantityError(0n, consumption.quantity, message)
    }
    // The lot's live consumptions include this sale's own, restored a moment ago.
    const sold = soldQuantity(lot)
    if (sold > lot.quantity) {
      const left = lot.quantity - (sold - consumption.quantity)
      const available = left > 0n ? left : 0n
      const message = refused(`it took ${took} from the purchase of ${lot.acquiredAt}, which now has only ${units(available)} left to sell.`)
      throw new InsufficientQuantityError(available, consumption.quantity, message)
    }
    const cost = soldCost(lot)
    if (lot.costBasisPaise < cost) {
      const message = refused(
        `with it, sales would take ${formatPaise(cost)} of the cost of the purchase of ${lot.acquiredAt}, which now costs ${formatPaise(lot.costBasisPaise)} in all.`,
      )
      throw new LotInUseError(message, [{ code: "AMOUNT_BELOW_SOLD", message }])
    }
    if (sold === lot.quantity && lot.costBasisPaise !== cost) {
      const message = refused(
        `with it, all of the purchase of ${lot.acquiredAt} is sold, for a cost of ${formatPaise(cost)}, but that purchase now costs ${formatPaise(lot.costBasisPaise)}.`,
      )
      throw new LotInUseError(message, [{ code: "SOLD_COST_CHANGED", message }])
    }
  }
}
