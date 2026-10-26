import type { LedgerNode, Transaction } from "@prisma/client"
import { compareDates, fromDbDate, type CalendarDate } from "@/domain/calendar-date"
import type { SystemNodeRole } from "@/domain/ledger-kind"
import { allocateLots, InsufficientQuantityError, type LotAllocation } from "@/domain/lots"
import type { Paise } from "@/domain/money"
import { formatQuantity, type Quantity } from "@/domain/quantity"
import { validateTransaction } from "@/domain/transaction-rules"
import { openLots, valueHolding, type HoldingLot, type PricePoint } from "@/domain/valuation"
import type { HoldingDetail, HoldingView, LotView, NotValuedReason, Portfolio } from "@/lib/investment-view"
import { KIND_COPY } from "@/lib/node-kinds"
import { serialisePaise } from "@/lib/serialise"
import type { TransactionView } from "@/lib/transaction-view"
import { DuplicateIdempotencyKeyError, NotFoundError } from "@/server/repositories/errors"
import {
  findConsumptionsByTransaction,
  findLiveLots,
  findLotGaps,
  insertConsumptions,
  lockHoldings,
} from "@/server/repositories/lot-repository"
import { findNodes } from "@/server/repositories/node-repository"
import {
  createTransactionGroup,
  findGroupById,
  findTransactionsByIdempotencyKeys,
  insertTransactions,
  sumBalances,
} from "@/server/repositories/transaction-repository"
import { inTransaction, type UnitOfWork } from "@/server/repositories/unit-of-work"
import { findStalePriceDays } from "@/server/repositories/user-repository"
import { todayFor } from "@/server/services/clock"
import { lotModeOf, ONE_UNIT, QUANTITY_LIMIT, unitOf } from "@/server/services/lot-rules"
import { snapshotPriceResolver } from "@/server/services/price-resolver"
import { InvalidTransactionError, type TransactionViolation } from "@/server/services/transaction-errors"
import { cleanNote, legKey, RequestKeyConflictError, requireNode, viewOf } from "@/server/services/transaction-service"

// Selling (or redeeming) part of an investment valued by its lots: a disposal (spec §7.5, plan calls 1, 3-6). This is
// the only way money leaves such an investment (lot-rules.ts refuses it on the generic path), so the lots and the ledger
// cannot drift apart.
//
// Which lots a sale takes is the investment's lot method (FIFO unless it says LIFO or highest cost first), over the lots
// acquired on or before the sale's day (call 6); what each lot still holds is derived from its live consumptions, all of
// them, whatever their day. The cost basis is what the allocator says (call 5). The sale posts as spec §7.5 says:
//
//   gain        INVESTMENT -> account  cost basis   +  Realised Gain -> account  gain        (a DISPOSAL group)
//   loss        INVESTMENT -> account  proceeds     +  INVESTMENT -> Realised Loss  loss     (a DISPOSAL group)
//   break-even  INVESTMENT -> account  proceeds                                              (one plain transaction)
//
// so the account always receives the proceeds and the investment always gives up exactly the cost basis. The first leg,
// INVESTMENT -> account, is the cost-basis leg in the words of the schema: the consumption rows point at it, and they are
// what makes the lots hold less (nothing remaining is stored). Deleting any leg deletes the sale; restoring brings it
// back with the same consumption rows, refused if the lots no longer hold them (transaction-service.ts, lot-rules.ts).
// A sale is never edited (call 4).
//
// Every write is in one database transaction, after a lock on the investment's lots (lockHoldings), so two sales of
// the same investment cannot both take the same units. A replayed request returns the stored sale (EC-17): each leg
// stores `<key>:<index>`, as the legs of a split do.

export interface SellInput {
  /** The investment sold from: valued by quantity or as a lump. */
  nodeId: string
  /** The account the proceeds go into: an asset, or a liability the sale pays towards. */
  toNodeId: string
  /** Micro-units. A lump investment is always sold whole, as 1 unit. */
  quantity: Quantity
  /** What the sale brought in, in all. */
  proceeds: Paise
  occurredAt: CalendarDate
  /** Applied to every leg. */
  note?: string
  /** One per submission of the Sell form. Never empty. */
  idempotencyKey: string
}

export interface SalePreview {
  costBasisPaise: Paise
  proceedsPaise: Paise
  /** Proceeds minus cost basis: negative for a loss. */
  gainPaise: Paise
  /** What the sale takes from each lot, in the order the lot method takes them. */
  allocations: { acquiredAt: CalendarDate; quantity: Quantity; costBasisPaise: Paise }[]
}

type SaleRequest = Omit<SellInput, "idempotencyKey" | "note">

const SALE_DESTINATIONS = new Set<LedgerNode["kind"]>(["ASSET", "LIABILITY"])

/** Everything wrong with the request that needs no lots to see, each with its code (one per form field). */
function saleViolations(node: LedgerNode, to: LedgerNode, input: SaleRequest): TransactionViolation[] {
  const violations: TransactionViolation[] = []
  const mode = lotModeOf(node)
  if (mode === null) {
    violations.push({
      code: "NOT_SOLD_BY_LOT",
      message:
        node.kind === "INVESTMENT"
          ? `${node.name} is valued by what was put into it, so it has no lots to sell. Record this as an ordinary transaction from it.`
          : `${node.name} is not an investment valued by quantity or as a lump, so there is nothing here to sell.`,
    })
  }
  if (node.archivedAt !== null) violations.push({ code: "ARCHIVED_SOURCE", message: `${node.name} is archived.` })
  if (!SALE_DESTINATIONS.has(to.kind)) {
    violations.push({
      code: "SALE_DESTINATION",
      message: `The money from a sale goes into an account, or towards a card or loan, not to ${KIND_COPY[to.kind].indefinite}.`,
    })
  }
  if (to.archivedAt !== null) violations.push({ code: "ARCHIVED_TARGET", message: `${to.name} is archived.` })
  if (input.quantity <= 0n || input.quantity >= QUANTITY_LIMIT) {
    violations.push({
      code: "QUANTITY_OUT_OF_RANGE",
      message: "Enter a quantity greater than zero, with at most 12 digits before the decimal point.",
    })
  } else if (mode === "LUMP" && input.quantity !== ONE_UNIT) {
    violations.push({ code: "LUMP_QUANTITY", message: `${node.name} is valued as one lump sum, so it is sold whole: its quantity is 1.` })
  }
  if (input.proceeds <= 0n) violations.push({ code: "NON_POSITIVE_AMOUNT", message: "The proceeds must be greater than zero." })
  return violations
}

const units = (node: LedgerNode, quantity: Quantity): string => `${formatQuantity(quantity)}${unitOf(node)}`

interface SalePlan {
  preview: SalePreview
  allocations: LotAllocation[]
}

/**
 * Validate the request and allocate it to the investment's lots as they are now (inside `uow` when given, after the
 * caller has locked them). Throws InvalidTransactionError for a request that breaks a rule, InsufficientQuantityError
 * (stating what is available, in units, EC-21) for more than the lots acquired by the sale's day still hold.
 */
async function planSale(userId: string, node: LedgerNode, to: LedgerNode, input: SaleRequest, uow?: UnitOfWork): Promise<SalePlan> {
  const violations = saleViolations(node, to, input)
  if (violations.length > 0) throw new InvalidTransactionError(violations.map((v) => v.message).join(" "), violations)

  const lots = (await findLiveLots(userId, node.id, uow)).filter((lot) => compareDates(lot.acquiredAt, input.occurredAt) <= 0)
  let allocations: LotAllocation[]
  try {
    allocations = allocateLots(openLots(lots), node.lotMethod ?? "FIFO", input.quantity)
  } catch (error) {
    if (!(error instanceof InsufficientQuantityError)) throw error
    throw new InsufficientQuantityError(
      error.available,
      error.requested,
      `Only ${units(node, error.available)} of ${node.name} is available to sell on ${input.occurredAt}, so ${units(node, error.requested)} cannot be sold.`,
    )
  }
  const costBasisPaise = allocations.reduce((sum, a) => sum + a.costBasisPaise, 0n)
  // A cost basis of nothing has no leg to carry it: the investment must give up a positive amount for the consumption
  // rows to point at, and a transaction of 0 is no transaction.
  if (costBasisPaise === 0n) {
    const message = `The cost of ${units(node, input.quantity)} of ${node.name} comes to less than half a paisa, so it cannot be sold on its own. Sell a larger quantity.`
    throw new InvalidTransactionError(message, [{ code: "QUANTITY_TOO_SMALL", message }])
  }
  const acquired = new Map(lots.map((lot) => [lot.id, lot.acquiredAt]))
  return {
    allocations,
    preview: {
      costBasisPaise,
      proceedsPaise: input.proceeds,
      gainPaise: input.proceeds - costBasisPaise,
      allocations: allocations.map((a) => ({
        acquiredAt: acquired.get(a.lotId) ?? input.occurredAt, // always found: every allocation is of one of `lots`
        quantity: a.quantity,
        costBasisPaise: a.costBasisPaise,
      })),
    },
  }
}

/**
 * The figures a sale would post: its cost basis, the gain (negative for a loss) and what it takes from each lot.
 * Writes nothing. Refuses exactly what sellInvestment refuses, with the same errors, so the form can show them before
 * it is submitted. Another user's node is NotFoundError (EC-8).
 */
export async function previewSale(userId: string, input: SaleRequest): Promise<SalePreview> {
  const node = await requireNode(userId, input.nodeId)
  const to = await requireNode(userId, input.toNodeId)
  return (await planSale(userId, node, to, input)).preview
}

/** The user's Realised Gain and Realised Loss nodes, created with the account (account-seed.ts). */
async function systemNodes(userId: string): Promise<Record<"REALISED_GAIN" | "REALISED_LOSS", LedgerNode>> {
  const nodes = await findNodes(userId, { kinds: ["INCOME_SOURCE", "EXPENSE"], includeArchived: true })
  const find = (role: SystemNodeRole): LedgerNode => {
    const node = nodes.find((n) => n.systemRole === role)
    if (!node) throw new Error(`This account has no ${role} node`) // every account is seeded with one
    return node
  }
  return { REALISED_GAIN: find("REALISED_GAIN"), REALISED_LOSS: find("REALISED_LOSS") }
}

interface LegDraft {
  fromNodeId: string
  toNodeId: string
  amountPaise: Paise
}

/** The legs of spec §7.5, the cost-basis leg (INVESTMENT -> account) first. */
function saleLegs(node: LedgerNode, to: LedgerNode, preview: SalePreview, system: Awaited<ReturnType<typeof systemNodes>>): LegDraft[] {
  const { costBasisPaise, proceedsPaise, gainPaise } = preview
  if (gainPaise > 0n) {
    return [
      { fromNodeId: node.id, toNodeId: to.id, amountPaise: costBasisPaise },
      { fromNodeId: system.REALISED_GAIN.id, toNodeId: to.id, amountPaise: gainPaise },
    ]
  }
  if (gainPaise < 0n) {
    return [
      { fromNodeId: node.id, toNodeId: to.id, amountPaise: proceedsPaise },
      { fromNodeId: node.id, toNodeId: system.REALISED_LOSS.id, amountPaise: -gainPaise },
    ]
  }
  return [{ fromNodeId: node.id, toNodeId: to.id, amountPaise: proceedsPaise }]
}

const SALE_KEYS = 2 // a sale has at most two legs; the key after them is looked up too, as for a split

/**
 * The stored result of an earlier submission of this sale, or null if the key was never used. It is a replay only if
 * it is a sale (the cost-basis leg under `<key>:0`, with its consumption rows, and the second leg under `<key>:1` in the
 * same DISPOSAL group, or no second leg and no group) and it is this sale: the same investment, account, day, quantity
 * and proceeds. Anything else holding one of the keys is some other request, and RequestKeyConflictError is thrown.
 * The note is not compared: it changes no figure.
 */
async function storedSale(userId: string, input: SellInput): Promise<{ legs: TransactionView[]; preview: SalePreview } | null> {
  const keys = Array.from({ length: SALE_KEYS + 1 }, (_, index) => legKey(input.idempotencyKey, index))
  const rows = await findTransactionsByIdempotencyKeys(userId, keys)
  if (rows.length === 0) return null
  const [first, second] = rows
  if (rows.length > SALE_KEYS || first.idempotencyKey !== keys[0]) throw new RequestKeyConflictError()
  const taken = await findConsumptionsByTransaction(userId, first.id)
  const group = first.groupId === null ? null : await findGroupById(userId, first.groupId)
  const isSale =
    taken.length > 0 &&
    (second === undefined
      ? group === null
      : group?.kind === "DISPOSAL" && second.idempotencyKey === keys[1] && second.groupId === first.groupId)
  if (!isSale) throw new RequestKeyConflictError()

  const costBasisPaise = taken.reduce((sum, c) => sum + c.costBasisPaise, 0n)
  const quantity = taken.reduce((sum, c) => sum + c.quantity, 0n)
  // A gain's second leg also pays the account; a loss's second leg leaves the investment for Realised Loss.
  const proceedsPaise =
    second !== undefined && second.fromNodeId !== first.fromNodeId ? first.amountPaise + second.amountPaise : first.amountPaise
  const same =
    first.fromNodeId === input.nodeId &&
    first.toNodeId === input.toNodeId &&
    fromDbDate(first.occurredAt) === input.occurredAt &&
    quantity === input.quantity &&
    proceedsPaise === input.proceeds
  if (!same) throw new RequestKeyConflictError()

  const today = await todayFor(userId)
  const legs: TransactionView[] = []
  for (const row of rows) legs.push(await viewOf(userId, row, undefined, today))
  return {
    legs,
    preview: {
      costBasisPaise,
      proceedsPaise,
      gainPaise: proceedsPaise - costBasisPaise,
      allocations: taken.map((c) => ({ acquiredAt: c.acquiredAt, quantity: c.quantity, costBasisPaise: c.costBasisPaise })),
    },
  }
}

/**
 * Sell `quantity` of an investment valued by quantity or as a lump, for `proceeds` paid into `toNodeId`: allocate it to
 * the lots by the investment's lot method, post the legs of spec §7.5 (see the top of this file) and record what was
 * taken from each lot against the cost-basis leg, all in one database transaction. Returns the legs' views, the
 * cost-basis leg first, and the figures posted (the same previewSale gives).
 *
 * Refused, with nothing written: InvalidTransactionError for a node that is not sold by lot (a CONTRIBUTION_ONLY
 * investment is an ordinary transaction, EC-28), a destination that is not an account (or a card or loan it pays
 * towards), an archived node (EC-14), a quantity or proceeds of zero or less, a lump sold other than whole, and a
 * quantity whose cost basis rounds to nothing; InsufficientQuantityError, stating what is available, for more than the
 * lots acquired by the sale's day hold (EC-21, call 6); NotFoundError for another user's node (EC-8).
 *
 * A replay of the same request key returns the stored sale and writes nothing (EC-17); a different request on the same
 * key is RequestKeyConflictError. As for a split, the stored legs are looked up first, so a node archived since does
 * not turn a replay into an error, and the unique key decides between submissions racing each other.
 */
export async function sellInvestment(userId: string, input: SellInput): Promise<{ legs: TransactionView[]; preview: SalePreview }> {
  // The schema refuses this too; the service is also called by code that never saw the schema.
  if (input.idempotencyKey === "") throw new InvalidTransactionError("A request key is required")
  const node = await requireNode(userId, input.nodeId)
  const to = await requireNode(userId, input.toNodeId)
  const replay = await storedSale(userId, input)
  if (replay) return replay
  const system = await systemNodes(userId)
  const keys = Array.from({ length: SALE_KEYS }, (_, index) => legKey(input.idempotencyKey, index))

  let written: { rows: Transaction[]; preview: SalePreview } | null
  try {
    written = await inTransaction(async (uow) => {
      await lockHoldings(userId, node.id, uow)
      // A submission of the same key that held the lock before this one has committed by now: its sale is the answer,
      // and allocating again against the lots it left would refuse a request that already succeeded.
      if ((await findTransactionsByIdempotencyKeys(userId, keys, uow)).length > 0) return null
      const { preview, allocations } = await planSale(userId, node, to, input, uow)
      const legs = saleLegs(node, to, preview, system)
      // Never expected to refuse (the checks above cover every leg), but a leg is a transaction and is held to the rules.
      const nodesById = new Map([node, to, system.REALISED_GAIN, system.REALISED_LOSS].map((n) => [n.id, n]))
      for (const leg of legs) {
        const from = nodesById.get(leg.fromNodeId)
        const into = nodesById.get(leg.toNodeId)
        const broken = from && into ? validateTransaction({ fromNode: from, toNode: into, amount: leg.amountPaise, occurredAt: input.occurredAt }) : []
        if (broken.length > 0) throw new InvalidTransactionError(broken.map((v) => v.message).join(" "), broken)
      }
      const group = legs.length > 1 ? await createTransactionGroup(userId, "DISPOSAL", uow) : undefined
      const note = cleanNote(input.note)
      const rows = await insertTransactions(
        userId,
        legs.map((leg, index) => ({ ...leg, occurredAt: input.occurredAt, note, idempotencyKey: keys[index] })),
        group?.id,
        uow,
      )
      await insertConsumptions(
        userId,
        allocations.map((a) => ({ lotId: a.lotId, transactionId: rows[0].id, quantity: a.quantity, costBasisPaise: a.costBasisPaise })),
        uow,
      )
      return { rows, preview }
    })
  } catch (error) {
    // Lost a race to a submission of the same key that did not wait on the same lock (a different investment named).
    // The transaction, with any group row created in it, was rolled back.
    if (error instanceof DuplicateIdempotencyKeyError) {
      const stored = await storedSale(userId, input) // throws if it is not this sale
      if (stored) return stored
    }
    throw error
  }
  if (written === null) {
    const stored = await storedSale(userId, input)
    if (stored) return stored
    throw new RequestKeyConflictError() // unreachable: the keys were found a moment ago and are never released
  }

  const today = await todayFor(userId)
  const legs: TransactionView[] = []
  for (const row of written.rows) legs.push(await viewOf(userId, row, [node], today))
  return { legs, preview: written.preview }
}

// ---------------------------------------------------------------------------------------------------------------------
// The read half: holdings, the portfolio, and the valuations net worth counts (spec §7.3, plan calls 5-7, 9).
//
// An investment valued by quantity or as a lump is worth its open quantity at the latest price on or before the day,
// rounded once (valueHolding). It is NOT valued, which is never zero and never cost (EC-23), when it holds units with no
// such price ("NO_PRICE"), or when some of its live entries are not accounted for by lots, a purchase with no lot or a
// withdrawal with no consumption, made before lots existed ("NEEDS_QUANTITY", call 7): its quantity is then unknown,
// whatever its price. Nothing held is worth exactly nothing, priced or not. An investment valued by what was put into
// it is worth that contribution: it has no lots and no price, is never "not valued", and net worth reads its balance.
//
// Every figure is "as of a day" (call 6), today in the user's own timezone unless a day is given. Prices are read through
// the PriceResolver seam (spec §7.4). Everything returned to a screen is plain data (investment-view.ts).

/** What the value of one investment held by lots rests on, read together. */
export interface HoldingInputs {
  /** The live lots, each with its live consumptions, oldest entry first. */
  lots: HoldingLot[]
  points: PricePoint[]
  /** Some live entry is not accounted for by a lot (call 7): the holding is not known, so it is not valued. */
  needsQuantity: boolean
}

/** Read the lots, the prices and the entries lots do not account for, of one of the user's investments held by lots. */
export async function readHoldingInputs(userId: string, nodeId: string): Promise<HoldingInputs> {
  const [gaps, lots, points] = await Promise.all([
    findLotGaps(userId, nodeId),
    findLiveLots(userId, nodeId),
    snapshotPriceResolver.pricesFor(userId, nodeId),
  ])
  return { lots, points, needsQuantity: gaps.inflowsWithoutLot + gaps.outflowsWithoutConsumption > 0 }
}

// The staleness window only labels the price; it never changes a value. What valueAt passes for it is never read back.
const ANY_WINDOW = 0

/** The holding's value on `asOf`: null when not valued (no price for a held quantity, or call 7); 0 when nothing is held. */
export function valueAt(inputs: HoldingInputs, asOf: CalendarDate): Paise | null {
  if (inputs.needsQuantity) return null
  return valueHolding({ lots: inputs.lots, points: inputs.points, asOf, stalePriceDays: ANY_WINDOW }).valuePaise
}

/** The live lots bought by `asOf`: the ones a holding on that day is made of, sold out or not. */
const lotsBy = (lots: readonly HoldingLot[], asOf: CalendarDate): HoldingLot[] =>
  lots.filter((lot) => compareDates(lot.acquiredAt, asOf) <= 0)

const investments = (userId: string) => findNodes(userId, { kinds: ["INVESTMENT"], includeArchived: true })

/** The view of an investment held by lots, valued on `asOf` with the node's staleness window or else the user's (call 9). */
function lotHoldingView(node: LedgerNode, inputs: HoldingInputs, asOf: CalendarDate, userWindow: number): HoldingView {
  const holding = valueHolding({ lots: inputs.lots, points: inputs.points, asOf, stalePriceDays: node.stalePriceDays ?? userWindow })
  const valuePaise = inputs.needsQuantity ? null : holding.valuePaise
  const notValued: NotValuedReason | null = inputs.needsQuantity ? "NEEDS_QUANTITY" : valuePaise === null ? "NO_PRICE" : null
  const valued = valuePaise !== null
  return {
    nodeId: node.id,
    name: node.name,
    unitLabel: node.unitLabel,
    valuationMode: node.valuationMode,
    archived: node.archivedAt !== null,
    quantityHeld: formatQuantity(holding.quantityHeld),
    costBasisPaise: serialisePaise(holding.costBasisPaise),
    valuePaise: valued ? serialisePaise(valuePaise) : null,
    unrealisedGainPaise: valued && holding.unrealisedGainPaise !== null ? serialisePaise(holding.unrealisedGainPaise) : null,
    // A handful of digits (a 100x gain is 1,000,000 basis points): far inside what a number holds exactly.
    gainBasisPoints: valued && holding.gainBasisPoints !== null ? Number(holding.gainBasisPoints) : null,
    price: holding.price && {
      asOf: holding.price.asOf,
      pricePerUnitPaise: serialisePaise(holding.price.pricePerUnitPaise),
      stale: holding.price.stale,
    },
    notValued,
    lotCount: lotsBy(inputs.lots, asOf).length,
  }
}

/** The view of an investment valued by what was put into it: worth exactly its balance, with no gain to speak of. */
function contributionHoldingView(node: LedgerNode, balance: Paise): HoldingView {
  return {
    nodeId: node.id,
    name: node.name,
    unitLabel: node.unitLabel,
    valuationMode: node.valuationMode,
    archived: node.archivedAt !== null,
    quantityHeld: "0",
    costBasisPaise: serialisePaise(balance),
    valuePaise: serialisePaise(balance),
    unrealisedGainPaise: "0",
    gainBasisPoints: balance > 0n ? 0 : null,
    price: null,
    notValued: null,
    lotCount: 0,
  }
}

function lotView(lot: HoldingLot, asOf: CalendarDate): LotView {
  const [open] = openLots([lot], asOf) // none when the lot is sold out by `asOf`
  return {
    id: lot.id,
    acquiredAt: lot.acquiredAt,
    quantity: formatQuantity(lot.quantity),
    quantityRemaining: formatQuantity(open?.quantityRemaining ?? 0n),
    costBasisPaise: serialisePaise(lot.costBasisPaise),
    costBasisRemainingPaise: serialisePaise(open?.costBasisRemainingPaise ?? 0n),
  }
}

async function balanceOn(userId: string, nodeId: string, asOf: CalendarDate): Promise<Paise> {
  return (await sumBalances(userId, asOf)).find((row) => row.nodeId === nodeId)?.balance ?? 0n
}

/**
 * One investment of the user on `asOf` (today by default): its holding and value, its lots (oldest first) with what each
 * still holds on that day, and every price it has (newest first). NotFoundError for another user's node (EC-8) or a node
 * that is not an investment. Plain data, safe to hand to a client component.
 */
export async function loadHolding(userId: string, nodeId: string, asOf?: CalendarDate): Promise<HoldingDetail> {
  const node = await requireNode(userId, nodeId)
  if (node.kind !== "INVESTMENT") throw new NotFoundError("node")
  const day = asOf ?? (await todayFor(userId))
  if (lotModeOf(node) === null) {
    return { ...contributionHoldingView(node, await balanceOn(userId, node.id, day)), lots: [], prices: [] }
  }
  const [inputs, userWindow] = await Promise.all([readHoldingInputs(userId, node.id), findStalePriceDays(userId)])
  return {
    ...lotHoldingView(node, inputs, day, userWindow),
    lots: lotsBy(inputs.lots, day).map((lot) => lotView(lot, day)),
    prices: [...inputs.points]
      .sort((a, b) => compareDates(b.asOf, a.asOf))
      .map((point) => ({ asOf: point.asOf, pricePerUnitPaise: serialisePaise(point.pricePerUnitPaise) })),
  }
}

/**
 * Every investment of the user, archived ones included, on `asOf` (today by default), and the totals across them: what
 * was put in (every holding's cost), and the value and gain of the ones that can be valued, with a count of those that
 * cannot. Plain data, safe to hand to a client component.
 */
export async function loadPortfolio(userId: string, asOf?: CalendarDate): Promise<Portfolio> {
  const day = asOf ?? (await todayFor(userId))
  const [nodes, userWindow, balances] = await Promise.all([investments(userId), findStalePriceDays(userId), sumBalances(userId, day)])
  const balanceOf = new Map(balances.map((row) => [row.nodeId, row.balance]))
  const holdings = await Promise.all(
    nodes.map(async (node) =>
      lotModeOf(node) === null
        ? contributionHoldingView(node, balanceOf.get(node.id) ?? 0n)
        : lotHoldingView(node, await readHoldingInputs(userId, node.id), day, userWindow),
    ),
  )
  const sum = (pick: (holding: HoldingView) => string | null): string =>
    serialisePaise(holdings.reduce((total, holding) => total + BigInt(pick(holding) ?? "0"), 0n))
  return {
    holdings,
    totals: {
      contributedPaise: sum((h) => h.costBasisPaise),
      valuePaise: sum((h) => h.valuePaise),
      unrealisedGainPaise: sum((h) => h.unrealisedGainPaise),
      notValuedCount: holdings.filter((h) => h.notValued !== null).length,
    },
  }
}

/**
 * The valuation of every investment the user holds by lots (archived ones included), on `asOf`, in the shape net worth
 * takes (`netWorth`, `buildNodeOverview`, `buildDashboard`): a value, or null when not valued, with the reason for each
 * null in `unvalued`. An investment valued by what was put into it is absent from both, so it counts at its balance.
 */
export async function loadValuationStates(
  userId: string,
  asOf: CalendarDate,
): Promise<{ valuations: Map<string, Paise | null>; unvalued: Map<string, NotValuedReason> }> {
  const held = (await investments(userId)).filter((node) => lotModeOf(node) !== null)
  const valued = await Promise.all(
    held.map(async (node) => {
      const inputs = await readHoldingInputs(userId, node.id)
      return { node, inputs, value: valueAt(inputs, asOf) }
    }),
  )
  const valuations = new Map<string, Paise | null>()
  const unvalued = new Map<string, NotValuedReason>()
  for (const { node, inputs, value } of valued) {
    valuations.set(node.id, value)
    if (value === null) unvalued.set(node.id, inputs.needsQuantity ? "NEEDS_QUANTITY" : "NO_PRICE")
  }
  return { valuations, unvalued }
}

/**
 * The value on `asOf` of every investment held by lots: only those appear; one that needs a quantity (call 7) or holds
 * units with no price maps to null; one sold out maps to 0. What `netWorth` takes as its `valuations`.
 */
export async function loadValuations(userId: string, asOf: CalendarDate): Promise<Map<string, Paise | null>> {
  return (await loadValuationStates(userId, asOf)).valuations
}
