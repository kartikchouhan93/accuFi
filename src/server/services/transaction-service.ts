import type { LedgerNode, Transaction } from "@prisma/client"
import { compareDates, fromDbDate, type CalendarDate } from "@/domain/calendar-date"
import { formatPaise, type Paise } from "@/domain/money"
import type { Quantity } from "@/domain/quantity"
import { validateTransaction, type RuleViolation } from "@/domain/transaction-rules"
import { SPLIT_LEGS_MAX, SPLIT_LEGS_MIN } from "@/lib/schemas/transaction"
import { toTransactionView, type TransactionView, type Warning } from "@/lib/transaction-view"
import { DuplicateIdempotencyKeyError, NotFoundError } from "@/server/repositories/errors"
import { findLotQuantities } from "@/server/repositories/lot-repository"
import { findNodeById } from "@/server/repositories/node-repository"
import {
  createTransactionGroup,
  detachFromGroup,
  findGroupById,
  findRestorable,
  findTransactionById,
  findTransactionsByIdempotencyKeys,
  insertTransactions,
  softDeleteGroup,
  softDeleteTransaction,
  sumBalances,
  undeleteGroup,
  undeleteTransaction,
  updateTransaction,
  VersionConflictError,
  type UpdateDraft,
} from "@/server/repositories/transaction-repository"
import { inTransaction, type UnitOfWork } from "@/server/repositories/unit-of-work"
import { todayFor } from "@/server/services/clock"
import {
  applyLotEdit,
  applyLotPurchase,
  assertNoLotFlow,
  assertNotASale,
  assertPurchaseRemovable,
  assertRestoredLotAllowed,
  assertRestoredSaleCovered,
  lockLotHoldings,
  lotModeOf,
  lotSourceViolation,
  splitLegViolation,
} from "@/server/services/lot-rules"
import { InvalidTransactionError, type TransactionViolation } from "@/server/services/transaction-errors"

// The central write path: record, edit, delete and restore one movement of money. Everything the database cannot
// enforce is enforced here: both nodes are the caller's (the repositories answer not-found for anyone else's, EC-8),
// the flow is legal (EC-6, EC-7), and a replayed request returns the first result (EC-17).
//
// Warnings (OVERDRAWN, OVER_CREDIT_LIMIT, FUTURE_DATED) are returned on the TransactionView, never thrown: the
// transaction is recorded either way (EC-10, EC-11, EC-12). The one thing that blocks is an asset with `blockNegative`
// set, which refuses a write that would take it below zero.
//
// blockNegative policy, in one place. A guarded node (an ASSET with `blockNegative`) is never taken below zero by a
// record, an edit (at either end of either version of the row) or a restore. Deletion is NEVER blocked: a user must
// always be able to remove a mistaken entry, and refusing would strand the error with no way out.
//
// Scope: warnings and the guard read balances at one day (`asOf`, today or the transaction's own later day), not across
// history. A backdated spend that holds an account negative for three weeks in the past and is covered by a later
// deposit warns about nothing: M1 judges the position as it stands, not every day it passed through. That is what the
// account form's switch promises and no more: "Block entries that would leave this account overdrawn as of today".
// Widening the guard to every day in between is a later milestone's decision; if it is made, change that label with it.
//
// Split groups (spec §4.1, EC-3, EC-13, EC-19). A split is two or more transactions that are one real-world event,
// written together in one database transaction under a shared `groupId`, and deleted, restored and displayed as a
// unit. Each leg is an ordinary transaction (source -> its own destination) and is held to the flow rules on its own.
// Policy for the group as a whole: every leg is validated before any is written; the overdraft guard and the warnings
// judge the source once, after the whole group, so the legs are weighed by their sum and never leg by leg; a group
// never has fewer than two live members; deleting or restoring any member deletes or restores them all.
//
// Lots (spec §7.2). A purchase into a lot-mode investment creates its lot in the same database transaction as the row,
// the lot follows the row through edits, and money leaves such an investment only through a sale. The rules live in
// lot-rules.ts, shared with the sale path; this service calls them at each write (record, edit, delete, restore, split).
//
// Sign convention (spec §4.2), the one every balance in the application follows: a balance is inflows - outflows with
// no per-kind special case, so a liability you owe on is NEGATIVE. Nothing below flips that: an overdrawn asset is a
// balance below zero; a card is over its limit when its balance is below minus the limit.

export type { TransactionView, Warning }
export { lotModeOf, type LotMode } from "@/server/services/lot-rules"
export {
  InvalidTransactionError,
  LotInUseError,
  type LotRuleCode,
  type TransactionViolation,
  type TransactionViolationCode,
} from "@/server/services/transaction-errors"

export interface RecordTransactionInput {
  fromNodeId: string
  toNodeId: string
  amount: Paise
  occurredAt: CalendarDate
  /**
   * What a purchase into a lot-mode investment bought, in micro-units: required into one valued by quantity, 1 unit (or
   * left out) into one valued as a lump, and refused anywhere else.
   */
  quantity?: Quantity
  note?: string
  tags?: string[]
  /** One per submission of a form, chosen by the client. Never empty: see IDEMPOTENCY_KEY_MIN_LENGTH. */
  idempotencyKey: string
}

/** What an edit may change. Fields left out are kept; `note: null` clears the note. */
export interface EditTransactionInput {
  fromNodeId?: string
  toNodeId?: string
  amount?: Paise
  occurredAt?: CalendarDate
  /** A new quantity for the purchase's lot, or the quantity of a purchase that has none yet. Cannot be cleared. */
  quantity?: Quantity
  note?: string | null
  tags?: string[]
}

/**
 * The request key was already used for something other than exactly this request. For a split that is a replay with a
 * different shape, or a replay of a group that has since been broken up: in the second case the earlier request did
 * succeed, which is why this is its own type and not just a message. A subclass, so everything that handles
 * InvalidTransactionError still does.
 */
export class RequestKeyConflictError extends InvalidTransactionError {
  constructor() {
    super("This request key was already used for a different request.")
    this.name = "RequestKeyConflictError"
  }
}

/** The write would take an asset that sets `blockNegative` below zero. Nothing was written. */
export class OverdraftBlockedError extends Error {
  constructor(readonly nodeName: string) {
    super(`${nodeName} does not allow a negative balance, so this would overdraw it.`)
    this.name = "OverdraftBlockedError"
  }
}

/** The caller's node, archived or not; NotFoundError for anyone else's. Shared with the sale path. */
export async function requireNode(userId: string, nodeId: string, uow?: UnitOfWork): Promise<LedgerNode> {
  const node = await findNodeById(userId, nodeId, uow) // archived nodes included: history still points at them
  if (!node) throw new NotFoundError("node") // someone else's node is simply "not found"
  return node
}

/**
 * The day balances are read at for a transaction dated `occurredAt`: today, or the transaction's own day if that is
 * later. A future-dated transaction is outside today's balance (EC-10), so judging it against today would never notice
 * that it overdraws the account on the day it lands.
 */
const asOfFor = (today: CalendarDate, occurredAt: CalendarDate): CalendarDate =>
  compareDates(occurredAt, today) > 0 ? occurredAt : today

export const cleanNote = (note: string | null | undefined): string | null => note?.trim() || null
export const cleanTags = (tags: readonly string[]): string[] => [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== ""))]

const legalityViolations = (from: LedgerNode, to: LedgerNode, amount: Paise, occurredAt: CalendarDate, allowArchived: boolean) =>
  validateTransaction({ fromNode: from, toNode: to, amount, occurredAt }, { allowArchived })

function assertLegal(from: LedgerNode, to: LedgerNode, amount: Paise, occurredAt: CalendarDate, allowArchived: boolean): void {
  const violations = legalityViolations(from, to, amount, occurredAt, allowArchived)
  if (violations.length > 0) throw new InvalidTransactionError(violations.map((v) => v.message).join(" "), violations)
}

// Only an asset can be overdrawn (EC-11): an expense or income node is a flow total, a liability is meant to be negative.
const isGuarded = (node: LedgerNode): boolean => node.kind === "ASSET" && node.blockNegative

async function balancesAt(userId: string, asOf: CalendarDate, uow: UnitOfWork): Promise<Map<string, Paise>> {
  return new Map((await sumBalances(userId, asOf, uow)).map((row) => [row.nodeId, row.balance]))
}

/**
 * Refuse a write that left a guarded node below zero. `before` is the balances read ahead of the write; a node that
 * was already below zero is only refused if the write lowered it further, so an edit that does not touch the money
 * (a note, a tag) is not held to an overdraft that was there already. Without `before` any negative balance refuses.
 */
function assertNoOverdraft(nodes: readonly LedgerNode[], after: Map<string, Paise>, before?: Map<string, Paise>): void {
  for (const node of nodes.filter(isGuarded)) {
    const now = after.get(node.id) ?? 0n
    if (now < 0n && (before === undefined || now < (before.get(node.id) ?? 0n))) throw new OverdraftBlockedError(node.name)
  }
}

/**
 * Run `write` in one database transaction and, if any of `nodes` is a guarded asset, check it did not overdraw it,
 * rolling the write back if it did. The check reads inside the same transaction, so it sees the write itself.
 * Checking after the write rather than predicting it has two virtues: it needs no arithmetic over the old and new
 * versions of an edit, and a replayed create (whose insert is refused as a duplicate before the check runs) can never
 * be mistaken for a second spend.
 */
async function writeUnlessOverdrawn<T>(
  userId: string,
  nodes: readonly LedgerNode[],
  asOf: CalendarDate,
  write: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
  return inTransaction(async (uow) => {
    const guarded = nodes.some(isGuarded)
    const before = guarded ? await balancesAt(userId, asOf, uow) : undefined
    const result = await write(uow)
    if (guarded) assertNoOverdraft(nodes, await balancesAt(userId, asOf, uow), before)
    return result
  })
}

/**
 * The warnings a stored transaction carries, judged against the balances as they are now, over the nodes `touched`
 * (de-duplicated by id; a node that is both the old and the new end is judged once). A create or a restore touches its
 * source only: the node it lowers. An edit touches all four ends, as the overdraft guard does, because money can leave a
 * node at either end of either version of the row (lowering a deposit overdraws its destination, not its source).
 * A card whose balance is -60,000 against a 50,000 limit is over it (owed = -balance); an asset below zero is
 * overdrawn; a liability or an expense below zero says nothing. Ordered OVERDRAWN, OVER_CREDIT_LIMIT, FUTURE_DATED.
 */
async function warningsFor(userId: string, row: Transaction, touched: readonly LedgerNode[], today: CalendarDate): Promise<Warning[]> {
  const occurredAt = fromDbDate(row.occurredAt)
  const balances = new Map((await sumBalances(userId, asOfFor(today, occurredAt))).map((b) => [b.nodeId, b.balance]))
  const nodes = [...new Map(touched.map((node) => [node.id, node])).values()]
  const overdrawn: Warning[] = []
  const overLimit: Warning[] = []
  for (const node of nodes) {
    const balance = balances.get(node.id) ?? 0n
    if (node.kind === "ASSET" && balance < 0n) {
      overdrawn.push({ code: "OVERDRAWN", message: `${node.name} is overdrawn: its balance is ${formatPaise(balance)}.` })
    }
    if (node.kind === "LIABILITY" && node.creditLimitPaise !== null && -balance > node.creditLimitPaise) {
      overLimit.push({
        code: "OVER_CREDIT_LIMIT",
        message: `${node.name} is over its credit limit: ${formatPaise(-balance)} owed against a limit of ${formatPaise(node.creditLimitPaise)}.`,
      })
    }
  }
  const future: Warning[] =
    compareDates(occurredAt, today) > 0
      ? [
          {
            code: "FUTURE_DATED",
            message: `This is dated ${occurredAt}, after today, so it is left out of the current balance and shown as projected.`,
          },
        ]
      : []
  return [...overdrawn, ...overLimit, ...future]
}

/**
 * The view of a stored row, with its warnings. `touched` and `today` are passed when the caller already has them
 * (default: the row's source node). A soft-deleted row has no warnings: it moves no money.
 */
export async function viewOf(
  userId: string,
  row: Transaction,
  touched?: readonly LedgerNode[],
  today?: CalendarDate,
): Promise<TransactionView> {
  if (row.deletedAt !== null) return toTransactionView(row)
  const nodes = touched ?? [await requireNode(userId, row.fromNodeId)]
  return toTransactionView(row, await warningsFor(userId, row, nodes, today ?? (await todayFor(userId))))
}

/**
 * The view of a stored row with what its lot holds (`quantity`), for a form that is about to edit it: the stored side of a
 * version conflict, which the form can take up whole. No warnings: nothing was written.
 */
export async function storedViewOf(userId: string, row: Transaction): Promise<TransactionView> {
  const quantities = await findLotQuantities(userId, [row.id])
  return toTransactionView(row, [], quantities.get(row.id) ?? null)
}

/**
 * Record a transaction. Validated against the flow rules with archived nodes refused: a new entry must not select one
 * (EC-14); a refusal writes nothing. Returns the new row's view with its warnings. A purchase into a lot-mode investment
 * creates its lot in the same database transaction; money out of one is refused (see "Lots" above).
 *
 * A replayed `idempotencyKey` returns the first result (EC-17). That is decided by the unique constraint on
 * (userId, idempotencyKey), not by looking first: the insert is the one atomic test-and-set, so two submissions racing
 * each other cannot both pass an existence check and both insert. Postgres makes the second insert wait for the first
 * to commit and then fail the constraint; the repository turns that into DuplicateIdempotencyKeyError carrying the
 * committed row, and that row is the answer. The replay's own fields are ignored: the stored row is the first result.
 */
export async function recordTransaction(userId: string, input: RecordTransactionInput): Promise<TransactionView> {
  // The schema refuses this; the service is also called by code that never saw the schema. The repository stores ""
  // as a real key but its duplicate lookup treats it as none, so a second "" would surface as a raw database error.
  if (input.idempotencyKey === "") throw new InvalidTransactionError("A request key is required")
  const from = await requireNode(userId, input.fromNodeId)
  const to = await requireNode(userId, input.toNodeId)
  const today = await todayFor(userId)

  let row: Transaction
  try {
    row = await writeUnlessOverdrawn(userId, [from, to], asOfFor(today, input.occurredAt), async (uow) => {
      // A purchase into an investment held by lots decides from what its lots hold (a lump is bought once): hold them
      // still first, before any row is written, so two first purchases of one lump from two tabs cannot both pass.
      await lockLotHoldings(userId, [to], uow)
      const [inserted] = await insertTransactions(
        userId,
        [
          {
            fromNodeId: from.id,
            toNodeId: to.id,
            amountPaise: input.amount,
            occurredAt: input.occurredAt,
            note: cleanNote(input.note),
            tags: cleanTags(input.tags ?? []),
            idempotencyKey: input.idempotencyKey,
          },
        ],
        undefined,
        uow,
      )
      // After the insert, inside the transaction: a replay stops at the duplicate above and never reaches this line, so
      // a key that was valid when first used still gets its first result if a node was archived since. An invalid
      // request is rolled back with the transaction, so nothing is left behind.
      assertLegal(from, to, input.amount, input.occurredAt, false)
      await applyLotPurchase(
        userId,
        { from, to, transactionId: inserted.id, amount: input.amount, occurredAt: input.occurredAt, quantity: input.quantity },
        uow,
      )
      return inserted
    })
  } catch (error) {
    // The repository's duplicate lookup runs on the shared client, not on the aborted transaction, and it runs while
    // this call's transaction connection is still being released. So a burst of N replays of one key can briefly hold
    // up to 2N pool connections (N transactions failing, N lookups). Headroom is ample today; whoever tunes the
    // Prisma `connection_limit` down should keep it above the largest burst of identical submissions they expect.
    if (error instanceof DuplicateIdempotencyKeyError) return viewOf(userId, error.existing)
    throw error
  }
  return viewOf(userId, row, [from], today)
}

/**
 * Edit a transaction, if it is still at `expectedVersion`; otherwise throw VersionConflictError carrying the stored row
 * (EC-18). The result is revalidated as a whole against the flow rules (EC-16), but archived nodes are allowed:
 * a historical transaction that references one must stay correctable (EC-14). Throws NotFoundError for an unknown,
 * deleted or other user's transaction or node. The row's lot moves with it in the same database transaction (EC-15,
 * EC-16; see "Lots" above), and a sale is refused outright: it is deleted and entered again.
 */
export async function editTransaction(
  userId: string,
  id: string,
  input: EditTransactionInput,
  expectedVersion: number,
): Promise<TransactionView> {
  const existing = await findTransactionById(userId, id)
  if (!existing) throw new NotFoundError("transaction")
  // Reported before validating, so a stale edit is a conflict rather than an error about a merge of out-of-date fields.
  // The repository checks again, atomically, with the write.
  if (existing.version !== expectedVersion) throw new VersionConflictError(existing)
  await assertNotASale(userId, existing)

  const fromId = input.fromNodeId ?? existing.fromNodeId
  const toId = input.toNodeId ?? existing.toNodeId
  const amount = input.amount ?? existing.amountPaise
  const occurredAt = input.occurredAt ?? fromDbDate(existing.occurredAt)
  const from = await requireNode(userId, fromId)
  const to = await requireNode(userId, toId)
  // Archived nodes are tolerated, so a historical row that references one stays correctable (EC-14) ...
  assertLegal(from, to, amount, occurredAt, true)
  // ... but only the ones it already references. A node this edit newly names is a fresh selection, and archived
  // nodes are never selectable for that (EC-14): refuse it as a new entry would be.
  const existingEnds = [existing.fromNodeId, existing.toNodeId]
  const introduced: RuleViolation[] = []
  if (input.fromNodeId !== undefined && !existingEnds.includes(from.id) && from.archivedAt !== null) {
    introduced.push({ code: "ARCHIVED_SOURCE", message: "The source node is archived." })
  }
  if (input.toNodeId !== undefined && !existingEnds.includes(to.id) && to.archivedAt !== null) {
    introduced.push({ code: "ARCHIVED_TARGET", message: "The target node is archived." })
  }
  if (introduced.length > 0) throw new InvalidTransactionError(introduced.map((v) => v.message).join(" "), introduced)
  // A row whose ends are unchanged is judged as it stands, so an entry from before lots existed that took money out of a
  // lot-mode investment stays correctable (its note, its amount); choosing an end afresh is held to the rule of a new entry.
  if (from.id !== existing.fromNodeId || to.id !== existing.toNodeId) assertNoLotFlow(from, to)

  // Money can leave a guarded node at either end of either version of the row: a larger spend, a smaller deposit, a
  // changed account. The old ends are checked as well as the new ones.
  const oldTo = await requireNode(userId, existing.toNodeId)
  const touched = [from, to, await requireNode(userId, existing.fromNodeId), oldTo]
  const changes: UpdateDraft = {
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    amountPaise: input.amount,
    occurredAt: input.occurredAt,
    note: input.note === undefined ? undefined : cleanNote(input.note),
    tags: input.tags === undefined ? undefined : cleanTags(input.tags),
  }
  const today = await todayFor(userId)
  const row = await writeUnlessOverdrawn(userId, touched, asOfFor(today, occurredAt), async (uow) => {
    // The investments whose lots this edit may change, locked before the row is written (lockLotHoldings).
    await lockLotHoldings(userId, [oldTo, to], uow)
    const updated = await updateTransaction(userId, id, changes, expectedVersion, uow)
    await applyLotEdit(userId, { existing, oldTo, to, amount, occurredAt, quantity: input.quantity }, uow)
    return updated
  })
  return viewOf(userId, row, touched, today)
}

/**
 * Soft-delete (EC-13): the row stays, balances stop counting it, and its idempotency key stays reserved. Throws
 * NotFoundError if it is not this user's or is already deleted. Deleting is never refused for an overdraft: it removes
 * an entry the user has decided was wrong, and blocking that would strand a mistake.
 *
 * A member of a split group takes the whole group with it: half of a split is a corrupt record of one event, whichever
 * leg the user happened to click. To remove one leg and keep the rest, ungroup it first.
 *
 * The one refusal: a purchase whose lot a live sale has taken from throws LotInUseError, changing nothing. Delete the
 * sale first. (That is not an overdraft rule; it keeps a sale from consuming a lot that no longer counts.)
 */
export async function removeTransaction(userId: string, id: string): Promise<void> {
  await inTransaction(async (uow) => {
    const row = await findTransactionById(userId, id, uow)
    if (!row) throw new NotFoundError("transaction")
    // A leg of a split never has a lot, so only the row itself can carry one.
    await assertPurchaseRemovable(userId, row, uow)
    if (row.groupId === null) await softDeleteTransaction(userId, id, uow)
    else await softDeleteGroup(userId, row.groupId, uow)
  })
}

/**
 * Bring a soft-deleted transaction back, and with it the rest of its split group, if it had one. Archived nodes do not
 * stop it: it is history. A restore is a new debit on its source node, so it is refused if that node blocks overdrafts
 * and the restored rows would take it below zero; a group is then refused whole. A restored purchase's lot counts again,
 * so it is refused if another live purchase already holds the same lump investment (lot-rules.ts). A restored sale takes
 * from its lots again with the consumption rows it kept (nothing is re-allocated), so it is refused, whole, if they no
 * longer hold what it took: InsufficientQuantityError or LotInUseError (assertRestoredSaleCovered).
 */
export async function restoreTransaction(userId: string, id: string): Promise<TransactionView> {
  const today = await todayFor(userId)
  const row = await inTransaction(async (uow) => {
    // The investments the restored rows touch, locked before any row is written (lockLotHoldings): a restored sale's
    // lots are judged below, and a restored purchase's lot counts again.
    const restorable = await findRestorable(userId, id, uow)
    // Not this user's, or not deleted, as this statement saw it. A delete still in flight is not waited for: it reads as
    // live here, and restoring what was not seen deleted would revive rows whose investments were never locked.
    if (restorable.length === 0) throw new NotFoundError("transaction")
    const ends = [...new Set(restorable.flatMap((each) => [each.fromNodeId, each.toNodeId]))]
    const nodes: LedgerNode[] = []
    for (const nodeId of ends) nodes.push(await requireNode(userId, nodeId, uow))
    await lockLotHoldings(userId, nodes, uow)
    const restored = await undeleteTransaction(userId, id, uow)
    const siblings = restored.groupId === null ? [] : await undeleteGroup(userId, restored.groupId, uow)
    // Each statement reads its own snapshot, so a delete that committed after findRestorable may have added rows to
    // what the undelete revived. Every revived row must be one whose ends were locked above; if not, the restore is
    // refused whole (it rolls back) rather than judged without the lock. Deleted rows are never edited, so the ends of
    // a row that was seen are the ends that were locked.
    const locked = new Set(restorable.map((each) => each.id))
    if (![restored, ...siblings].every((each) => locked.has(each.id))) throw new NotFoundError("transaction")
    for (const each of [restored, ...siblings]) {
      await assertRestoredLotAllowed(userId, each, uow)
      await assertRestoredSaleCovered(userId, each, uow)
      const from = await requireNode(userId, each.fromNodeId, uow)
      if (isGuarded(from)) {
        assertNoOverdraft([from], await balancesAt(userId, asOfFor(today, fromDbDate(each.occurredAt)), uow))
      }
    }
    return restored
  })
  return viewOf(userId, row, undefined, today)
}

export interface SplitLegInput {
  toNodeId: string
  amount: Paise
  note?: string
}

export interface RecordSplitInput {
  fromNodeId: string
  /** One day for every leg: a split is one event. */
  occurredAt: CalendarDate
  legs: SplitLegInput[]
  /** What the user said the event cost in all. If given, the legs must add up to exactly this (EC-3). */
  total?: Paise
  /** Applied to every leg. */
  tags?: string[]
  /** One per submission of the form, as for a single transaction; see legKey for what the legs store. */
  idempotencyKey: string
}

/** The legs of a split do not add up to the total the user stated. The message is safe to show. Nothing was written. */
export class SplitTotalMismatchError extends Error {
  constructor(legsTotal: Paise, statedTotal: Paise) {
    super(`The legs add up to ${formatPaise(legsTotal)} but the total is ${formatPaise(statedTotal)}.`)
    this.name = "SplitTotalMismatchError"
  }
}

// One request key covers N rows, but the database allows a key once per user (R7). Each leg stores `<key>:<index>`.
// The client's key is validated against the 16-character floor (schemas/transaction.ts) as sent, not these derived
// forms, which are only ever longer. The legs are written in one database transaction, so a replay finds all of them
// or none.
// A sale's legs (investment-service.ts) are keyed the same way.
export const legKey = (key: string, index: number): string => `${key}:${index}`

/**
 * The stored result of an earlier submission of this split, or null if the key was never used. A match is a replay only
 * if it is exactly that submission: every one of the `legCount` derived keys is found, no more (the key after the last
 * leg is looked up too, so an original with more legs is not mistaken for this one), and all the rows share one group.
 * Any other row holding one of the keys belongs to some other request (a single transaction that happens to be keyed
 * `<key>:1`, a split of a different size, a group since broken up), and answering with it would report success for a
 * split that was never recorded, so that is a conflict and is thrown.
 */
async function storedSplit(userId: string, key: string, legCount: number): Promise<TransactionView[] | null> {
  const keys = Array.from({ length: legCount }, (_, index) => legKey(key, index))
  const rows = await findTransactionsByIdempotencyKeys(userId, [...keys, legKey(key, legCount)])
  if (rows.length === 0) return null
  const [first] = rows
  const isReplay =
    rows.length === legCount &&
    rows.every((row, index) => row.idempotencyKey === keys[index] && row.groupId !== null && row.groupId === first.groupId)
  if (!isReplay) throw new RequestKeyConflictError()
  const today = await todayFor(userId)
  const views: TransactionView[] = []
  for (const row of rows) views.push(await viewOf(userId, row, undefined, today))
  return views
}

/**
 * Record one real-world event as several transactions from one source, one per leg, sharing a new group of kind
 * MANUAL_SPLIT. Returns the legs' views in the order given.
 *
 * The legs must be legal and add up to `total` if it is stated, or `SplitTotalMismatchError` / `InvalidTransactionError`
 * is thrown with nothing written. Every leg is checked, and every violation reported with its leg (the structured
 * `TransactionViolation.leg`, and "Leg N" in the message), before any row is written. Archived nodes are refused, as for
 * a new transaction (EC-14).
 *
 * The group row and all legs are written in one database transaction, so a failure anywhere (a duplicate key, an
 * overdraft) leaves neither. The overdraft guard reads the source before and after the whole group, so legs that each
 * fit but together overdraw a `blockNegative` asset are refused. Warnings are those of a single create (the source
 * node only) judged against the balance after the whole group, and they are the same on every leg's view because each
 * leg is one of the writes that left the source in that state; show them once.
 *
 * A replay returns the stored legs and writes nothing (EC-17): looked up first only as a shortcut, so that a node
 * archived since does not turn a replay into an error; the unique key remains the arbiter between concurrent submissions.
 */
export async function recordSplit(userId: string, input: RecordSplitInput): Promise<TransactionView[]> {
  if (input.idempotencyKey === "") throw new InvalidTransactionError("A request key is required")
  // The schema refuses these too; the service is also called by code that never saw the schema.
  if (input.legs.length < SPLIT_LEGS_MIN) throw new InvalidTransactionError(`A split needs at least ${SPLIT_LEGS_MIN} legs.`)
  if (input.legs.length > SPLIT_LEGS_MAX) throw new InvalidTransactionError(`A split can have at most ${SPLIT_LEGS_MAX} legs.`)
  const legsTotal = input.legs.reduce((sum, leg) => sum + leg.amount, 0n)
  if (input.total !== undefined && legsTotal !== input.total) throw new SplitTotalMismatchError(legsTotal, input.total)

  const from = await requireNode(userId, input.fromNodeId)
  const destinations: LedgerNode[] = []
  for (const leg of input.legs) destinations.push(await requireNode(userId, leg.toNodeId))

  const keys = input.legs.map((_, index) => legKey(input.idempotencyKey, index))
  const replay = await storedSplit(userId, input.idempotencyKey, input.legs.length)
  if (replay) return replay

  // The source is the same for every leg, so an archived source is one problem, reported once and without a leg: it is
  // not any one leg's fault, and the form flags the source field for it. So is a lot-mode source (call 3).
  const violations: TransactionViolation[] = input.legs.flatMap((leg, index) =>
    legalityViolations(from, destinations[index], leg.amount, input.occurredAt, false).flatMap((violation): TransactionViolation[] => {
      if (violation.code === "ARCHIVED_SOURCE") return index === 0 ? [violation] : []
      return [{ ...violation, leg: index, message: `Leg ${index + 1}: ${violation.message}` }]
    }),
  )
  if (lotModeOf(from) !== null) violations.push(lotSourceViolation(from))
  destinations.forEach((destination, index) => {
    if (lotModeOf(destination) !== null) violations.push(splitLegViolation(destination, index))
  })
  if (violations.length > 0) throw new InvalidTransactionError(violations.map((v) => v.message).join(" "), violations)

  const today = await todayFor(userId)
  const tags = cleanTags(input.tags ?? [])
  let rows: Transaction[]
  try {
    rows = await writeUnlessOverdrawn(userId, [from, ...destinations], asOfFor(today, input.occurredAt), async (uow) => {
      const group = await createTransactionGroup(userId, "MANUAL_SPLIT", uow)
      return insertTransactions(
        userId,
        input.legs.map((leg, index) => ({
          fromNodeId: from.id,
          toNodeId: leg.toNodeId,
          amountPaise: leg.amount,
          occurredAt: input.occurredAt,
          note: cleanNote(leg.note),
          tags,
          idempotencyKey: keys[index],
        })),
        group.id,
        uow,
      )
    })
  } catch (error) {
    // Lost a race to a concurrent submission of the same key; its legs are the answer. The transaction (and the group
    // row created in it) was rolled back.
    if (error instanceof DuplicateIdempotencyKeyError) {
      const stored = await storedSplit(userId, input.idempotencyKey, input.legs.length) // throws if it is not ours
      if (stored) return stored
    }
    throw error
  }
  // All legs share a day and a source, so one judgement serves them all.
  const warnings = await warningsFor(userId, rows[0], [from], today)
  return rows.map((row) => toTransactionView(row, warnings))
}

/**
 * Break one leg out of its split group (EC-19): it becomes a plain transaction and the money does not move. If that
 * leaves a single leg, that leg is released too and the empty group removed, since a group of one is not a split.
 * A disposal group (EC-19), a sale, is deleted as a unit and never edited, so it refuses. Idempotent: a transaction in no group is returned as it is. Throws NotFoundError for an unknown, deleted or other
 * user's transaction.
 */
export async function ungroupTransaction(userId: string, id: string): Promise<TransactionView> {
  const row = await inTransaction(async (uow) => {
    const existing = await findTransactionById(userId, id, uow)
    if (!existing) throw new NotFoundError("transaction")
    if (existing.groupId !== null) {
      const group = await findGroupById(userId, existing.groupId, uow)
      if (group?.kind === "DISPOSAL") {
        throw new InvalidTransactionError("A sale is deleted as a unit, so one leg cannot be taken out of it.")
      }
    }
    return detachFromGroup(userId, id, uow)
  })
  return toTransactionView(row) // no money moved, so there is nothing new to warn about
}
