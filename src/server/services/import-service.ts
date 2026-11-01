import { createHash } from "node:crypto"
import type { CounterpartRule, ImportBatchStatus, ImportRow, ImportRowStatus, LedgerNode } from "@prisma/client"
import { addDays, compareDates, fromDbDate, toDbDate, type CalendarDate } from "@/domain/calendar-date"
import { decodeBytes, looksLikeText, parseCsv, type CsvRow } from "@/domain/import-csv"
import { defaultSignConvention, parseImportRow, type ImportDirection, type ImportMapping, type ParsedRow } from "@/domain/import-map"
import {
  DUPLICATE_WINDOW_DAYS,
  findDuplicate,
  isLegalCounterpart,
  matchOccurrences,
  suggestFromRules,
  type ExistingTxn,
  type OccurrenceCandidate,
} from "@/domain/import-match"
import { validateTransaction } from "@/domain/transaction-rules"
import { importMappingSchema } from "@/lib/schemas/import"
import {
  REVIEW_PAGE_SIZE,
  toBatchView,
  toReviewRowView,
  type BatchView,
  type ReviewFilter,
  type ReviewRowView,
  type ReviewScreen,
} from "@/lib/import-view"
import { NOTE_MAX_LENGTH } from "@/lib/schemas/transaction"
import { serialisePaise } from "@/lib/serialise"
import { NotFoundError } from "@/server/repositories/errors"
import {
  countRows,
  deleteRows,
  findBatchById,
  findBatches,
  findCounterpartRules,
  findEarlierUpload,
  findProfileById,
  findProfiles,
  findRowById,
  findRows,
  insertBatch,
  insertRows,
  lockBatch,
  markRowsCommitted,
  readBatchBytes,
  transitionBatch,
  updateRow as updateImportRow,
  updateRowsWhereSame,
  upsertProfile,
  upsertRule,
  type RowData,
} from "@/server/repositories/import-repository"
import {
  findOccurrenceById,
  findPendingForAccount,
  markPosted,
  reopenPostedByTransactions,
  type OccurrenceWithRule,
} from "@/server/repositories/recurring-repository"
import {
  findAccountTransactions,
  findTransactionById,
  insertTransactions,
  softDeleteByBatch,
  type InsertDraft,
} from "@/server/repositories/transaction-repository"
import { inTransaction, type UnitOfWork } from "@/server/repositories/unit-of-work"
import { lotModeOf } from "@/server/services/lot-rules"
import { listAllNodes } from "@/server/services/node-service"
import { asOfFor, assertNoOverdraft, balancesAt, isGuarded, requireNode } from "@/server/services/transaction-service"
import { todayFor } from "@/server/services/clock"

export { REVIEW_PAGE_SIZE, type ReviewFilter, type ReviewRowView, type ReviewScreen }

// Stages 1 to 3 of the import (design §6): upload a file, preview it against a mapping, stage it into rows. The
// review and decide screens (stage 4) and commit/reverse (stage 5) are later tasks; everything they need comes
// through what this module stores (PENDING/ERRORED rows, the probable duplicate and recurring link, a prefilled
// counterpart) and reads back (loadMapScreen, the repository's row queries).
//
// Statement bytes never leave this file and a file's content never reaches an error message: every refusal here is a
// fixed string, never built from the cells it read.

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024
export const IMPORT_MAX_ROWS = 20_000

// `commitBatch`'s single interactive transaction runs a handful of queries per READY row (an occurrence lookup for a
// linked row, the insert, markRowsCommitted's update, up to three for markPosted, upsertRule) even after node lookups
// are cached per distinct id rather than per row. Prisma's default interactive-transaction timeout (5000ms) is sized
// for an ordinary request, not a commit that may touch IMPORT_MAX_ROWS rows, and would surface as an unmapped P2028 to
// the user well before a large, otherwise-legal statement finished committing. 10ms of budget per row at the ceiling
// is generous for same-connection queries with no network round trip, while still bounding how long a stuck commit
// can hold the row lock.
const COMMIT_TRANSACTION_TIMEOUT_MS = IMPORT_MAX_ROWS * 10

const FILE_ERROR_MESSAGE: Record<"EMPTY" | "TOO_LARGE" | "NOT_TEXT" | "TOO_MANY_ROWS", string> = {
  EMPTY: "The file is empty.",
  TOO_LARGE: `The file is larger than ${IMPORT_MAX_BYTES / (1024 * 1024)} MB.`,
  NOT_TEXT: "The file does not look like a text file.",
  TOO_MANY_ROWS: `The file has more than ${IMPORT_MAX_ROWS} rows.`,
}

/** A refusal of the uploaded file itself, before anything in it is read. The message never contains its content. */
export class ImportFileError extends Error {
  constructor(readonly code: "EMPTY" | "TOO_LARGE" | "NOT_TEXT" | "TOO_MANY_ROWS") {
    super(FILE_ERROR_MESSAGE[code])
    this.name = "ImportFileError"
  }
}

export interface ImportViolation {
  field: string
  message: string
}

/** The request breaks an import rule (a bad account, an unstageable batch, an undecodable mapping). Nothing was written. */
export class InvalidImportError extends Error {
  constructor(readonly violations: ImportViolation[]) {
    super(violations.map((v) => v.message).join(" "))
    this.name = "InvalidImportError"
  }
}

/** Staging was asked for without confirming a known earlier upload of the same bytes (EC-54). Nothing was written. */
export class ImportRepeatUnconfirmedError extends Error {
  constructor() {
    super("This file was uploaded before. Confirm to stage it again.")
    this.name = "ImportRepeatUnconfirmedError"
  }
}

const FILE_NAME_MAX_LENGTH = 200

function checkFile(bytes: Uint8Array): void {
  if (bytes.length === 0) throw new ImportFileError("EMPTY")
  if (bytes.length > IMPORT_MAX_BYTES) throw new ImportFileError("TOO_LARGE")
  if (!looksLikeText(bytes)) throw new ImportFileError("NOT_TEXT")
}

function assertImportableAccount(node: LedgerNode): void {
  if (node.archivedAt !== null || (node.kind !== "ASSET" && node.kind !== "LIABILITY")) {
    throw new InvalidImportError([{ field: "nodeId", message: "Choose a live asset or liability account for the import." }])
  }
}

/**
 * Upload a statement for an account: the account must be the user's own, live, and an ASSET or LIABILITY (investments
 * are not importable, design call 3); a foreign id is NotFoundError, a wrong kind or archived is InvalidImportError.
 * The file is hashed as it is (SHA-256 hex) and stored whole; it is refused, before hashing, if it is empty, over
 * `IMPORT_MAX_BYTES`, or does not look like text. The file name is trimmed and held to `FILE_NAME_MAX_LENGTH`.
 */
export async function createBatch(
  userId: string,
  input: { nodeId: string; fileName: string; bytes: Uint8Array; profileId?: string | null },
): Promise<BatchView> {
  const node = await requireNode(userId, input.nodeId)
  assertImportableAccount(node)
  checkFile(input.bytes)
  const fileHash = createHash("sha256").update(input.bytes).digest("hex")
  const batch = await insertBatch(userId, {
    nodeId: input.nodeId,
    fileName: input.fileName.trim().slice(0, FILE_NAME_MAX_LENGTH),
    fileSize: input.bytes.length,
    fileHash,
    fileBytes: input.bytes,
    profileId: input.profileId ?? null,
  })
  return toBatchView(batch, node.name)
}

/** Whether the mapping has real columns to parse with, as opposed to the map screen's own "not chosen yet" (-1). */
function columnsChosen(mapping: ImportMapping): boolean {
  const { columns } = mapping
  if (columns.date < 0 || columns.description < 0) return false
  const hasAmount = columns.amount !== undefined && columns.amount >= 0
  const hasSplit = columns.debit !== undefined && columns.debit >= 0 && columns.credit !== undefined && columns.credit >= 0
  return hasAmount || hasSplit
}

const isBlankRow = (cells: readonly string[]): boolean => cells.every((cell) => cell.trim() === "")

/**
 * Tokenize decoded text under a mapping: the header row it names (if `skipRows` names one) and the data rows after
 * it, with a row whose cells are all empty or whitespace dropped silently (an Excel-style trailing blank line is
 * noise, never a row; Task 1's ruling). A row the tokenizer itself could not read (an unterminated quote) is kept,
 * carrying its own error, so it still becomes one ERRORED row rather than vanishing. Shared by the preview and
 * staging, so the two agree on exactly which rows exist.
 */
function tokenizeForMapping(text: string, mapping: ImportMapping): { header: string[]; dataRows: CsvRow[] } {
  const rows = parseCsv(text, mapping.delimiter)
  const header = mapping.skipRows > 0 ? (rows[mapping.skipRows - 1]?.cells ?? []) : []
  const dataRows = rows.slice(mapping.skipRows).filter((row) => row.error !== undefined || !isBlankRow(row.cells))
  return { header, dataRows }
}

export interface PreviewRow {
  line: number
  cells: string[]
  parsed: { occurredOn: string; amountPaise: string; direction: ImportDirection; description: string } | null
  error: string | null
}

/** One preview row: a tokenizer error, no columns chosen yet (a prompt, not an error), or what staging would store. */
function previewRowOf(row: CsvRow, mapping: ImportMapping): PreviewRow {
  if (row.error !== undefined) return { line: row.line, cells: row.cells, parsed: null, error: row.error }
  if (!columnsChosen(mapping)) return { line: row.line, cells: row.cells, parsed: null, error: null }
  const result = parseImportRow(row.cells, mapping)
  if (!result.ok) return { line: row.line, cells: row.cells, parsed: null, error: result.error }
  const { value } = result
  return {
    line: row.line,
    cells: row.cells,
    parsed: {
      occurredOn: value.occurredOn,
      amountPaise: serialisePaise(value.amountPaise),
      direction: value.direction,
      description: value.description,
    },
    error: null,
  }
}

function defaultMapping(account: { kind: "ASSET" | "LIABILITY" }): ImportMapping {
  return {
    delimiter: ",",
    encoding: "utf-8",
    skipRows: 1,
    dateFormat: "DD/MM/YYYY",
    decimalSeparator: ".",
    signConvention: defaultSignConvention(account.kind),
    columns: { date: -1, description: -1 },
  }
}

export interface MapScreen {
  batch: BatchView
  account: { id: string; name: string; kind: "ASSET" | "LIABILITY" }
  mapping: ImportMapping
  decodeError: string | null
  /** The first 10 decoded lines, exactly as the file reads, so a wrong encoding is obvious. */
  sample: string[]
  headerCells: string[]
  previewRows: PreviewRow[]
  profiles: { id: string; name: string }[]
  earlier: { batchId: string; uploadedAt: string; status: ImportBatchStatus } | null
}

/**
 * The map-and-preview screen (design §6 stage 2): the batch, its account, the mapping in effect (the one given, else
 * the batch's saved profile, else a plain default with its columns unset), the first 20 rows as staging would store
 * them, and whether an earlier upload of the same bytes exists (EC-54; discarded earlier uploads do not count).
 * Bytes are read once here and never kept past this call. Throws NotFoundError("import") for a batch that is not the
 * user's.
 */
export async function loadMapScreen(userId: string, batchId: string, mapping?: ImportMapping): Promise<MapScreen> {
  const batch = await findBatchById(userId, batchId)
  if (!batch) throw new NotFoundError("import")
  const node = await requireNode(userId, batch.nodeId)
  const account = { id: node.id, name: node.name, kind: node.kind as "ASSET" | "LIABILITY" }

  const [bytes, profiles, earlierBatch] = await Promise.all([
    readBatchBytes(userId, batchId),
    findProfiles(userId),
    findEarlierUpload(userId, batch.fileHash, batchId),
  ])

  let effectiveMapping: ImportMapping
  if (mapping) {
    effectiveMapping = mapping
  } else {
    const profile = batch.profileId ? await findProfileById(userId, batch.profileId) : null
    effectiveMapping = profile ? importMappingSchema.parse(profile.settings) : defaultMapping(account)
  }

  let decodeError: string | null = null
  let sample: string[] = []
  let headerCells: string[] = []
  let previewRows: PreviewRow[] = []

  if (bytes === null) {
    decodeError = "The file's bytes are no longer stored."
  } else {
    const decoded = decodeBytes(bytes, effectiveMapping.encoding)
    if (!decoded.ok) {
      decodeError = decoded.error
    } else {
      sample = decoded.text.split(/\r\n|\r|\n/).slice(0, 10)
      const { header, dataRows } = tokenizeForMapping(decoded.text, effectiveMapping)
      headerCells = header
      previewRows = dataRows.slice(0, 20).map((row) => previewRowOf(row, effectiveMapping))
    }
  }

  return {
    batch: toBatchView(batch, node.name),
    account,
    mapping: effectiveMapping,
    decodeError,
    sample,
    headerCells,
    previewRows,
    profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
    earlier: earlierBatch
      ? { batchId: earlierBatch.id, uploadedAt: earlierBatch.createdAt.toISOString(), status: earlierBatch.status }
      : null,
  }
}

/** Save a mapping under a name, for reuse on the next statement from the same bank (design §6 stage 2, "Save as profile"). */
export async function saveProfile(
  userId: string,
  input: { name: string; nodeId?: string | null; mapping: ImportMapping },
): Promise<{ id: string; name: string }> {
  const profile = await upsertProfile(userId, { name: input.name, nodeId: input.nodeId ?? null, settings: input.mapping })
  return { id: profile.id, name: profile.name }
}

/** The direction and other ledger of a pending occurrence, relative to the batch's account. */
function occurrenceCandidateOf(occurrence: OccurrenceWithRule, accountNodeId: string): OccurrenceCandidate {
  const { rule } = occurrence
  const direction: ImportDirection = rule.fromNodeId === accountNodeId ? "OUT" : "IN"
  return {
    occurrenceId: occurrence.id,
    ruleName: rule.name,
    dueOn: fromDbDate(occurrence.dueOn),
    amountPaise: rule.amountPaise,
    direction,
    otherNodeId: direction === "OUT" ? rule.toNodeId : rule.fromNodeId,
  }
}

/** The widened date range a duplicate or occurrence lookup needs to cover every row, or null for no valid rows. */
function dateRangeOf(dates: readonly CalendarDate[]): { from: CalendarDate; to: CalendarDate } | null {
  if (dates.length === 0) return null
  let min = dates[0]
  let max = dates[0]
  for (const date of dates) {
    if (compareDates(date, min) < 0) min = date
    if (compareDates(date, max) > 0) max = date
  }
  return { from: addDays(min, -DUPLICATE_WINDOW_DAYS), to: addDays(max, DUPLICATE_WINDOW_DAYS) }
}

interface Entry {
  row: CsvRow
  parsed: ParsedRow | null
  error: string | null
}

/** The legal, non-archived counterpart a learned rule suggests, or null: isLegalCounterpart re-checked against today's ledgers. */
function suggestedCounterpart(
  account: { id: string; kind: "ASSET" | "LIABILITY" },
  direction: ImportDirection,
  descriptionKey: string,
  rules: readonly CounterpartRule[],
  nodeById: ReadonlyMap<string, LedgerNode>,
): string | null {
  const suggestion = suggestFromRules(direction, descriptionKey, rules)
  if (!suggestion) return null
  const counterpart = nodeById.get(suggestion)
  if (!counterpart) return null
  const legal = isLegalCounterpart(account, direction, {
    id: counterpart.id,
    kind: counterpart.kind,
    systemRole: counterpart.systemRole,
    archived: counterpart.archivedAt !== null,
    heldByLots: lotModeOf(counterpart) !== null,
  })
  return legal ? counterpart.id : null
}

/**
 * Stage a batch (design §6 stage 3): must be UPLOADED (else InvalidImportError); refuses with
 * ImportRepeatUnconfirmedError when an earlier upload of the same bytes exists and `confirmedRepeat` is false; decodes
 * the stored bytes with the mapping's encoding (a failure is InvalidImportError on field "encoding") and tokenizes
 * them; more than `IMPORT_MAX_ROWS` data rows is ImportFileError("TOO_MANY_ROWS"). Each row is parsed with
 * `parseImportRow`; a failure is stored ERRORED with its reason and raw cells (EC-56), everything else PENDING. The
 * account's transactions in the file's date range (widened by `DUPLICATE_WINDOW_DAYS`) drive `findDuplicate`; the
 * account's pending recurring occurrences drive `matchOccurrences`, recording `occurrenceId` on a matched row. A
 * learned rule prefills `counterpartNodeId` when it names a legal, live counterpart; the row still starts PENDING
 * either way (a prefill is not a decision). Everything is written and the batch moved to STAGED in one transaction,
 * under `lockBatch`. Throws NotFoundError("import") for a batch that is not the user's.
 */
export async function stageBatch(
  userId: string,
  batchId: string,
  mapping: ImportMapping,
  opts: { confirmedRepeat: boolean },
): Promise<{ rows: number; errored: number; duplicates: number; linked: number; suggested: number }> {
  return inTransaction(async (uow) => {
    const batch = await lockBatch(userId, batchId, uow)
    if (!batch) throw new NotFoundError("import")
    if (batch.status !== "UPLOADED") {
      throw new InvalidImportError([{ field: "id", message: "This import has already been staged." }])
    }

    if (!opts.confirmedRepeat) {
      const earlier = await findEarlierUpload(userId, batch.fileHash, batchId)
      if (earlier) throw new ImportRepeatUnconfirmedError()
    }

    const account = await requireNode(userId, batch.nodeId, uow)
    const bytes = await readBatchBytes(userId, batchId, uow)
    if (bytes === null) throw new NotFoundError("import")
    const decoded = decodeBytes(bytes, mapping.encoding)
    if (!decoded.ok) throw new InvalidImportError([{ field: "encoding", message: decoded.error }])

    const { dataRows } = tokenizeForMapping(decoded.text, mapping)
    if (dataRows.length > IMPORT_MAX_ROWS) throw new ImportFileError("TOO_MANY_ROWS")

    const entries: Entry[] = dataRows.map((row) => {
      if (row.error !== undefined) return { row, parsed: null, error: row.error }
      const result = parseImportRow(row.cells, mapping)
      return result.ok ? { row, parsed: result.value, error: null } : { row, parsed: null, error: result.error }
    })

    const validDates = entries.flatMap((entry) => (entry.parsed ? [entry.parsed.occurredOn] : []))
    const range = dateRangeOf(validDates)
    const [existingTxnRows, pendingOccurrences] = range
      ? await Promise.all([
          findAccountTransactions(userId, batch.nodeId, range.from, range.to, uow),
          findPendingForAccount(userId, batch.nodeId, uow),
        ])
      : [[], []]
    const existingTxns: ExistingTxn[] = existingTxnRows.map((txn) => ({
      id: txn.id,
      fromNodeId: txn.fromNodeId,
      toNodeId: txn.toNodeId,
      amountPaise: txn.amountPaise,
      occurredAt: fromDbDate(txn.occurredAt),
    }))
    const occurrenceCandidates = pendingOccurrences.map((occurrence) => occurrenceCandidateOf(occurrence, batch.nodeId))

    const validEntries: { index: number; parsed: ParsedRow }[] = []
    entries.forEach((entry, index) => {
      if (entry.parsed) validEntries.push({ index, parsed: entry.parsed })
    })
    const matchInputs = validEntries.map(({ parsed }) => ({
      occurredOn: parsed.occurredOn,
      amountPaise: parsed.amountPaise,
      direction: parsed.direction,
    }))
    const matched = matchOccurrences(matchInputs, occurrenceCandidates)
    const occurrenceByIndex = new Map<number, OccurrenceCandidate>()
    validEntries.forEach(({ index }, j) => {
      const candidate = matched[j]
      if (candidate) occurrenceByIndex.set(index, candidate)
    })

    const rules = await findCounterpartRules(userId, uow)
    const nodes = await listAllNodes(userId)
    const nodeById = new Map(nodes.map((n) => [n.id, n]))
    const accountInfo = { id: account.id, kind: account.kind as "ASSET" | "LIABILITY" }

    let errored = 0
    let duplicates = 0
    let linked = 0
    let suggested = 0
    const rows: RowData[] = entries.map((entry, index) => {
      if (entry.parsed === null) {
        errored++
        return {
          line: entry.row.line,
          raw: entry.row.cells,
          status: "ERRORED",
          errorReason: entry.error,
          occurredOn: null,
          amountPaise: null,
          direction: null,
          description: null,
          descriptionKey: null,
          counterpartNodeId: null,
          duplicateOfTransactionId: null,
          occurrenceId: null,
        }
      }
      const { parsed } = entry
      const duplicate = findDuplicate(parsed, batch.nodeId, existingTxns)
      if (duplicate) duplicates++
      const occurrence = occurrenceByIndex.get(index) ?? null
      if (occurrence) linked++
      const counterpartNodeId = suggestedCounterpart(accountInfo, parsed.direction, parsed.descriptionKey, rules, nodeById)
      if (counterpartNodeId) suggested++

      return {
        line: entry.row.line,
        raw: entry.row.cells,
        status: "PENDING",
        errorReason: null,
        occurredOn: toDbDate(parsed.occurredOn),
        amountPaise: parsed.amountPaise,
        direction: parsed.direction,
        description: parsed.description,
        descriptionKey: parsed.descriptionKey,
        counterpartNodeId,
        duplicateOfTransactionId: duplicate?.id ?? null,
        occurrenceId: occurrence?.occurrenceId ?? null,
      }
    })

    await insertRows(userId, batchId, rows, uow)
    const staged = await transitionBatch(userId, batchId, { from: ["UPLOADED"], to: "STAGED", mapping, rowCount: rows.length }, uow)
    if (!staged) throw new NotFoundError("import")

    return { rows: rows.length, errored, duplicates, linked, suggested }
  })
}

/** Discard an UPLOADED or STAGED batch (design §6): its rows and bytes go, it moves to DISCARDED. Already discarded is a
 * no-op. Throws InvalidImportError for any other status, NotFoundError("import") for a batch that is not the user's. */
export async function discardBatch(userId: string, batchId: string): Promise<void> {
  await inTransaction(async (uow) => {
    const batch = await lockBatch(userId, batchId, uow)
    if (!batch) throw new NotFoundError("import")
    if (batch.status === "DISCARDED") return
    if (batch.status !== "UPLOADED" && batch.status !== "STAGED") {
      throw new InvalidImportError([{ field: "id", message: "This import cannot be discarded." }])
    }
    await deleteRows(userId, batchId, uow)
    const result = await transitionBatch(userId, batchId, { from: [batch.status], to: "DISCARDED", dropBytes: true }, uow)
    if (!result) throw new NotFoundError("import")
  })
}

/** Send a STAGED batch back to UPLOADED: its rows go (they will be re-staged), its mapping stays. */
export async function backToMapping(userId: string, batchId: string): Promise<void> {
  await inTransaction(async (uow) => {
    const batch = await lockBatch(userId, batchId, uow)
    if (!batch) throw new NotFoundError("import")
    if (batch.status !== "STAGED") {
      throw new InvalidImportError([{ field: "id", message: "This import is not staged." }])
    }
    await deleteRows(userId, batchId, uow)
    const result = await transitionBatch(userId, batchId, { from: ["STAGED"], to: "UPLOADED" }, uow)
    if (!result) throw new NotFoundError("import")
  })
}

// The review screen and its row operations (design §6 stage 4). A row the user has not decided sits PENDING; a
// decision moves it to READY (it will be committed, Task 8) or SKIPPED (it will not); UNDO always puts it back to
// PENDING. Every write to a row goes through the repository's conditional `updateRow`, which refuses an ERRORED or
// COMMITTED row and any batch that is not STAGED in the one statement that writes it, so the three never need telling
// apart here: a null result is always NotFoundError("import"). A counterpart is checked against `isLegalCounterpart`
// here, against today's ledgers, every time one is set or re-used: a ledger legal when it was suggested or chosen can
// stop being legal later (archived, or turned into a lot holder), and the next write must notice.

const FILTER_STATUS: Partial<Record<ReviewFilter, ImportRowStatus[]>> = {
  pending: ["PENDING"],
  ready: ["READY"],
  skipped: ["SKIPPED"],
  errors: ["ERRORED"],
}

function totalForFilter(filter: ReviewFilter, counts: Awaited<ReturnType<typeof countRows>>): number {
  if (filter === "duplicates") return counts.duplicates
  const statuses = FILTER_STATUS[filter]
  if (statuses) return statuses.reduce((sum, status) => sum + counts.byStatus[status], 0)
  return Object.values(counts.byStatus).reduce((sum, n) => sum + n, 0) // "all"
}

/** Throws InvalidImportError (field "counterpartNodeId") unless `counterpartNodeId` is this user's and a legal counterpart. */
async function assertLegalCounterpart(
  userId: string,
  account: { id: string; kind: "ASSET" | "LIABILITY" },
  direction: ImportDirection,
  counterpartNodeId: string,
): Promise<void> {
  const node = await requireNode(userId, counterpartNodeId)
  const legal = isLegalCounterpart(account, direction, {
    id: node.id,
    kind: node.kind,
    systemRole: node.systemRole,
    archived: node.archivedAt !== null,
    heldByLots: lotModeOf(node) !== null,
  })
  if (!legal) {
    throw new InvalidImportError([{ field: "counterpartNodeId", message: "This ledger cannot be the counterpart of this row." }])
  }
}

/** The live transaction a row's `duplicateOfTransactionId` names, as the review screen shows it; null once it no longer resolves. */
async function duplicateViewOf(userId: string, transactionId: string, accountNodeId: string): Promise<ReviewRowView["duplicate"]> {
  const txn = await findTransactionById(userId, transactionId)
  if (!txn) return null
  const otherNodeId = txn.fromNodeId === accountNodeId ? txn.toNodeId : txn.fromNodeId
  const other = await requireNode(userId, otherNodeId)
  return {
    transactionId: txn.id,
    occurredAt: fromDbDate(txn.occurredAt),
    amountPaise: serialisePaise(txn.amountPaise),
    note: txn.note,
    otherLedgerName: other.name,
  }
}

/** The pending occurrence a row's `occurrenceId` names, as the review screen shows it; null once it no longer resolves. */
async function occurrenceViewOf(userId: string, occurrenceId: string, accountNodeId: string): Promise<ReviewRowView["occurrence"]> {
  const occurrence = await findOccurrenceById(userId, occurrenceId)
  if (!occurrence) return null
  const candidate = occurrenceCandidateOf(occurrence, accountNodeId)
  return { id: occurrence.id, ruleName: candidate.ruleName, dueOn: candidate.dueOn, otherNodeId: candidate.otherNodeId }
}

async function reviewRowViewOf(userId: string, row: ImportRow, accountNodeId: string): Promise<ReviewRowView> {
  const [duplicate, occurrence] = await Promise.all([
    row.duplicateOfTransactionId ? duplicateViewOf(userId, row.duplicateOfTransactionId, accountNodeId) : null,
    row.occurrenceId ? occurrenceViewOf(userId, row.occurrenceId, accountNodeId) : null,
  ])
  return toReviewRowView(row, duplicate, occurrence)
}

/**
 * The review screen (design §6 stage 4) for a STAGED batch: one page of its rows under `query.filter`, the batch's
 * counts by status plus duplicates and linked rows (always of the whole batch, not the filter), the ledgers a
 * counterpart may be chosen from (live, not a system node, not held by lots, not the account), and whether the batch
 * may be committed. `query.page` is 1-based and clamped to `[1, pageCount]`. Throws InvalidImportError if the batch is
 * not STAGED, NotFoundError("import") for a batch that is not the user's.
 */
export async function loadReview(
  userId: string,
  batchId: string,
  query: { filter: ReviewFilter; page: number },
): Promise<ReviewScreen> {
  const batch = await findBatchById(userId, batchId)
  if (!batch) throw new NotFoundError("import")
  if (batch.status !== "STAGED") {
    throw new InvalidImportError([{ field: "id", message: "This import is not staged." }])
  }
  const node = await requireNode(userId, batch.nodeId)
  const account = { id: node.id, name: node.name, kind: node.kind as "ASSET" | "LIABILITY" }

  const [counts, nodes] = await Promise.all([countRows(userId, batchId), listAllNodes(userId)])
  const total = totalForFilter(query.filter, counts)
  const pageCount = Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE))
  const requestedPage = Number.isFinite(query.page) ? Math.trunc(query.page) : 1
  const page = Math.min(Math.max(requestedPage, 1), pageCount)

  const statuses = FILTER_STATUS[query.filter]
  const rows = await findRows(userId, batchId, {
    offset: (page - 1) * REVIEW_PAGE_SIZE,
    limit: REVIEW_PAGE_SIZE,
    ...(statuses ? { status: statuses } : {}),
    ...(query.filter === "duplicates" ? { duplicatesOnly: true } : {}),
  })

  const ledgers = nodes
    .filter((n) => n.archivedAt === null && n.systemRole === null && n.id !== account.id && lotModeOf(n) === null)
    .map((n) => ({ id: n.id, name: n.name, kind: n.kind, archived: n.archivedAt !== null }))

  return {
    batch: toBatchView(batch, node.name),
    account,
    filter: query.filter,
    page,
    pageCount,
    counts: {
      pending: counts.byStatus.PENDING,
      ready: counts.byStatus.READY,
      skipped: counts.byStatus.SKIPPED,
      errored: counts.byStatus.ERRORED,
      duplicates: counts.duplicates,
      linked: counts.linked,
    },
    rows: await Promise.all(rows.map((row) => reviewRowViewOf(userId, row, account.id))),
    ledgers,
    canCommit: batch.status === "STAGED" && counts.byStatus.PENDING === 0 && counts.byStatus.READY > 0,
  }
}

export type RowChange = {
  counterpartNodeId?: string | null
  decision?: "IMPORT" | "SKIP" | "UNDO"
  occurrence?: "LINK" | "UNLINK"
}

/**
 * Change one row's decision (design §6 stage 4). `counterpartNodeId` (set or `null` to clear) is checked against
 * `isLegalCounterpart` before it is written. `occurrence: "LINK"` needs the row to already hold an `occurrenceId`
 * (from staging): it takes the rule's other ledger as the counterpart, under the same legality check; "UNLINK" only
 * clears the link, leaving any counterpart as it is. `decision: "IMPORT"` needs a counterpart: the one given in this
 * same call, else the row's own, else (if neither, the row holds a linked occurrence, and this same call is not also
 * unlinking it) the occurrence's other ledger; without one of those it is InvalidImportError on field
 * "counterpartNodeId" — in particular, combining `occurrence: "UNLINK"` with `decision: "IMPORT"` on a row with no
 * stored counterpart is refused this way, never silently re-deriving a counterpart from the link just removed.
 * "SKIP" and "UNDO" need no
 * counterpart. A row that is ERRORED or COMMITTED, or whose batch is not STAGED, is refused as NotFoundError("import"),
 * the same as a row that is not this user's; this is checked before anything else, since an ERRORED row has no
 * direction for `isLegalCounterpart` to check against.
 */
/** The row's linked occurrence's other ledger, legality-checked, or null if the row has none or it no longer resolves. */
async function linkedOccurrenceCounterpart(
  userId: string,
  row: ImportRow,
  account: { id: string; kind: "ASSET" | "LIABILITY" },
): Promise<string | null> {
  if (!row.occurrenceId) return null
  const occurrence = await findOccurrenceById(userId, row.occurrenceId)
  if (!occurrence) return null
  const candidate = occurrenceCandidateOf(occurrence, account.id)
  await assertLegalCounterpart(userId, account, candidate.direction, candidate.otherNodeId)
  return candidate.otherNodeId
}

export async function updateRow(userId: string, rowId: string, change: RowChange): Promise<ReviewRowView> {
  const row = await findRowById(userId, rowId)
  if (!row) throw new NotFoundError("import")
  const batch = await findBatchById(userId, row.batchId)
  if (!batch) throw new NotFoundError("import")
  if (row.status === "ERRORED" || row.status === "COMMITTED" || batch.status !== "STAGED") {
    throw new NotFoundError("import")
  }
  const node = await requireNode(userId, batch.nodeId)
  const account = { id: node.id, kind: node.kind as "ASSET" | "LIABILITY" }

  const changes: Partial<{ status: ImportRowStatus; counterpartNodeId: string | null; occurrenceId: string | null }> = {}

  if (change.occurrence === "UNLINK") {
    changes.occurrenceId = null
  } else if (change.occurrence === "LINK") {
    if (!row.occurrenceId) {
      throw new InvalidImportError([{ field: "occurrence", message: "This row has no linked recurring occurrence." }])
    }
    const counterpartNodeId = await linkedOccurrenceCounterpart(userId, row, account)
    if (!counterpartNodeId) throw new NotFoundError("occurrence")
    changes.counterpartNodeId = counterpartNodeId
  }

  if (change.counterpartNodeId !== undefined) {
    if (change.counterpartNodeId === null) {
      changes.counterpartNodeId = null
    } else {
      // row.direction is non-null here: an ERRORED row (the only kind with a null direction) was already refused above.
      await assertLegalCounterpart(userId, account, row.direction!, change.counterpartNodeId)
      changes.counterpartNodeId = change.counterpartNodeId
    }
  }

  if (change.decision === "SKIP") {
    changes.status = "SKIPPED"
  } else if (change.decision === "UNDO") {
    changes.status = "PENDING"
  } else if (change.decision === "IMPORT") {
    const hasExplicitCounterpart = changes.counterpartNodeId !== undefined
    let effective = hasExplicitCounterpart ? changes.counterpartNodeId : row.counterpartNodeId
    // No counterpart chosen in this call, and none stored yet: fall back to the row's own linked occurrence, if any
    // (already legality-checked above when `change.occurrence` was itself "LINK", so this only runs otherwise). Never
    // fall back when this same call is clearing the occurrence link (`occurrence: "UNLINK"`, `changes.occurrenceId ===
    // null`): the row's `occurrenceId` at this point still points at the link being removed, so deriving a
    // counterpart from it here would silently resurrect the very link this call is meant to clear.
    if (!effective && !hasExplicitCounterpart && changes.occurrenceId !== null) {
      effective = await linkedOccurrenceCounterpart(userId, row, account)
    }
    if (!effective) {
      throw new InvalidImportError([{ field: "counterpartNodeId", message: "Choose a counterpart before importing this row." }])
    }
    // A counterpart just set above (explicitly, from a linked occurrence just checked, or the fallback just above) is
    // already checked; only the row's own stored value, carried over unchanged, needs checking now, since it may have
    // stopped being legal since it was set.
    if (!hasExplicitCounterpart && effective === row.counterpartNodeId) {
      await assertLegalCounterpart(userId, account, row.direction!, effective)
    }
    changes.counterpartNodeId = effective
    changes.status = "READY"
  }

  const updated = await updateImportRow(userId, rowId, changes)
  if (!updated) throw new NotFoundError("import")
  return reviewRowViewOf(userId, updated, account.id)
}

/**
 * Copy `rowId`'s counterpart onto every PENDING row of its batch with the same direction and the same, non-empty
 * description key (the bulk "apply to similar" action): same account and direction, so the counterpart's legality is
 * one check, not one per row. Does nothing, and returns 0, if the row itself has no counterpart, no description key, or
 * the counterpart is no longer legal. Returns how many rows changed (the row itself counts, since it also matches).
 * Throws NotFoundError("import") for a row that is not this user's.
 */
export async function applyCounterpartToSimilar(userId: string, rowId: string): Promise<number> {
  const row = await findRowById(userId, rowId)
  if (!row) throw new NotFoundError("import")
  if (!row.counterpartNodeId || !row.direction || !row.descriptionKey) return 0
  const batch = await findBatchById(userId, row.batchId)
  if (!batch) throw new NotFoundError("import")
  const node = await requireNode(userId, batch.nodeId)
  const account = { id: node.id, kind: node.kind as "ASSET" | "LIABILITY" }
  const counterpart = await requireNode(userId, row.counterpartNodeId)
  const legal = isLegalCounterpart(account, row.direction, {
    id: counterpart.id,
    kind: counterpart.kind,
    systemRole: counterpart.systemRole,
    archived: counterpart.archivedAt !== null,
    heldByLots: lotModeOf(counterpart) !== null,
  })
  if (!legal) return 0
  return updateRowsWhereSame(
    userId,
    batch.id,
    { direction: row.direction, descriptionKey: row.descriptionKey, status: "PENDING" },
    { counterpartNodeId: row.counterpartNodeId },
  )
}

/**
 * Ready every PENDING row of the batch that already has a counterpart (a learned-rule prefill, or one chosen earlier)
 * and carries no duplicate flag: the bulk "confirm suggestions" action. A duplicate-flagged row is left PENDING even
 * with a counterpart; it needs the explicit "import anyway" decision (`updateRow` with `decision: "IMPORT"`). Returns
 * how many rows changed. Throws NotFoundError("import") for a batch that is not the user's.
 */
export async function confirmSuggestions(userId: string, batchId: string): Promise<number> {
  const batch = await findBatchById(userId, batchId)
  if (!batch) throw new NotFoundError("import")
  const candidates = await findRows(userId, batchId, { status: ["PENDING"], offset: 0, limit: IMPORT_MAX_ROWS })
  let count = 0
  for (const row of candidates) {
    if (row.counterpartNodeId === null || row.duplicateOfTransactionId !== null) continue
    const updated = await updateImportRow(userId, row.id, { status: "READY" })
    if (updated) count++
  }
  return count
}

// Commit and reversal (design §6 stage 5): the money-moving step. Nothing is written until the last moment: every
// READY row is re-validated against the ledgers as they are *now*, not as they were at staging or review, and the
// whole batch is re-validated before a single row is inserted. Everything from there (the inserts, marking the rows
// COMMITTED, posting linked occurrences, learning rules, moving the batch to COMMITTED and dropping its bytes) happens
// inside one `inTransaction`, under the row lock `lockBatch` takes: a failure anywhere leaves nothing written and the
// batch STAGED, and two concurrent commits of the same batch cannot both write (the second waits for the lock, then
// finds the batch already COMMITTED).

/** The batch is not STAGED or COMMITTED (already reversed, discarded, or still UPLOADED): nothing was written. */
export class ImportNotReadyError extends Error {
  constructor(readonly pending: number) {
    super(`${pending} row${pending === 1 ? "" : "s"} still need a decision before this import can be committed.`)
    this.name = "ImportNotReadyError"
  }
}

/** One or more READY rows are no longer legal to commit (a counterpart archived, a flow now illegal, a link resolved
 * since staging or review). Named by line, so the review screen can point at exactly what changed. Nothing was written. */
export class ImportRowsIllegalError extends Error {
  constructor(readonly rows: { line: number; reason: string }[]) {
    super(`${rows.length} row${rows.length === 1 ? "" : "s"} are no longer legal to commit: ${rows.map((r) => `line ${r.line} (${r.reason})`).join("; ")}`)
    this.name = "ImportRowsIllegalError"
  }
}

export interface CommitSummary {
  imported: number
  skipped: number
  linked: number
  errored: number
  firstDate: string | null
  lastDate: string | null
  totalInPaise: string
  totalOutPaise: string
  committedAt: string
}

/** The trimmed description, held to the note limit, or null for an empty one: what a committed row's transaction notes. */
function noteFromDescription(description: string | null): string | null {
  const trimmed = description?.trim() ?? ""
  return trimmed === "" ? null : trimmed.slice(0, NOTE_MAX_LENGTH)
}

/**
 * The summary of a committed batch, built from its own rows rather than kept anywhere: a repeat of `commitBatch`
 * reads the same COMMITTED rows and recomputes exactly the same figures, which is what makes it idempotent without a
 * stored copy. `direction`, `amountPaise` and `occurredOn` are never changed once a row is staged, and `occurrenceId`
 * is never cleared by a commit, so this reads the same thing every time it is called for this batch.
 */
async function buildCommitSummary(userId: string, batchId: string, committedAt: Date, uow?: UnitOfWork): Promise<CommitSummary> {
  const [counts, committed] = await Promise.all([
    countRows(userId, batchId, uow),
    findRows(userId, batchId, { status: ["COMMITTED"], offset: 0, limit: IMPORT_MAX_ROWS }, uow),
  ])
  let totalIn = 0n
  let totalOut = 0n
  let firstDate: CalendarDate | null = null
  let lastDate: CalendarDate | null = null
  let linked = 0
  for (const row of committed) {
    if (row.occurrenceId !== null) linked++
    const amount = row.amountPaise ?? 0n
    if (row.direction === "IN") totalIn += amount
    else totalOut += amount
    if (row.occurredOn !== null) {
      const day = fromDbDate(row.occurredOn)
      if (firstDate === null || compareDates(day, firstDate) < 0) firstDate = day
      if (lastDate === null || compareDates(day, lastDate) > 0) lastDate = day
    }
  }
  return {
    imported: committed.length,
    skipped: counts.byStatus.SKIPPED,
    linked,
    errored: counts.byStatus.ERRORED,
    firstDate,
    lastDate,
    totalInPaise: serialisePaise(totalIn),
    totalOutPaise: serialisePaise(totalOut),
    committedAt: committedAt.toISOString(),
  }
}

/** `requireNode`, but reusing a lookup already made earlier in the same `commitBatch` call: a statement commonly has
 * many rows against the same counterpart (one vendor, paid repeatedly), and this is what keeps that counterpart's
 * node from being fetched once per row rather than once per batch. */
async function cachedRequireNode(userId: string, nodeId: string, uow: UnitOfWork, cache: Map<string, LedgerNode>): Promise<LedgerNode> {
  const cached = cache.get(nodeId)
  if (cached) return cached
  const node = await requireNode(userId, nodeId, uow)
  cache.set(nodeId, node)
  return node
}

/** What a READY row needs, worked out and legality-checked before anything is written. */
interface PreparedRow {
  row: ImportRow
  counterpartNodeId: string
  fromNodeId: string
  toNodeId: string
}

/**
 * Work out and re-validate what one READY row would commit as, against the ledgers as they are right now: a linked
 * row (carried-forward ruling, Task 6->8) takes its counterpart from the occurrence's rule, never from the row's own
 * stored `counterpartNodeId`, and the occurrence must still be PENDING (handled since staging or review is a refusal,
 * not a re-link). An unlinked row is checked against its own stored counterpart. Either way the result is re-checked
 * with `isLegalCounterpart` (archived, system, lot-held, the account itself) and `validateTransaction` (both ends live,
 * the flow legal, a positive amount) exactly as a fresh entry would be. Returns a violation naming the row's line
 * instead of throwing, so the caller can collect every illegal row before refusing the whole commit.
 */
async function prepareReadyRow(
  userId: string,
  row: ImportRow,
  account: LedgerNode,
  accountInfo: { id: string; kind: "ASSET" | "LIABILITY" },
  uow: UnitOfWork,
  nodeCache: Map<string, LedgerNode>,
): Promise<{ prepared: PreparedRow } | { violation: { line: number; reason: string } }> {
  const direction = row.direction! // a READY row always has a direction: it came from a successfully parsed entry
  let counterpartNodeId = row.counterpartNodeId
  if (row.occurrenceId !== null) {
    const occurrence = await findOccurrenceById(userId, row.occurrenceId, uow)
    if (!occurrence || occurrence.status !== "PENDING") {
      return { violation: { line: row.line, reason: "The linked recurring occurrence is no longer pending." } }
    }
    // The rule may have been edited (fromNodeId/toNodeId) since this row was staged or reviewed, while the
    // occurrence it drives stayed PENDING and linked. Re-derive the candidate from the rule as it is *now*, and
    // refuse rather than re-link if the rule no longer actually touches this batch's account, or if its direction
    // relative to the account no longer matches what the row was staged as: either case means the counterpart this
    // candidate names is not the one the row's own direction/legality were ever checked against.
    const { rule } = occurrence
    if (rule.fromNodeId !== account.id && rule.toNodeId !== account.id) {
      return { violation: { line: row.line, reason: "The linked recurring rule no longer involves this account." } }
    }
    const candidate = occurrenceCandidateOf(occurrence, account.id)
    if (candidate.direction !== direction) {
      return { violation: { line: row.line, reason: "The linked recurring rule's direction no longer matches this row." } }
    }
    counterpartNodeId = candidate.otherNodeId
  }
  if (!counterpartNodeId) return { violation: { line: row.line, reason: "This row has no counterpart." } }

  const counterpart = await cachedRequireNode(userId, counterpartNodeId, uow, nodeCache)
  const legal = isLegalCounterpart(accountInfo, direction, {
    id: counterpart.id,
    kind: counterpart.kind,
    systemRole: counterpart.systemRole,
    archived: counterpart.archivedAt !== null,
    heldByLots: lotModeOf(counterpart) !== null,
  })
  if (!legal) return { violation: { line: row.line, reason: "This ledger can no longer be the counterpart of this row." } }

  const fromNode = direction === "OUT" ? account : counterpart
  const toNode = direction === "OUT" ? counterpart : account
  const violations = validateTransaction(
    { fromNode, toNode, amount: row.amountPaise!, occurredAt: fromDbDate(row.occurredOn!) },
    { allowArchived: false },
  )
  if (violations.length > 0) return { violation: { line: row.line, reason: violations.map((v) => v.message).join(" ") } }

  return {
    prepared: {
      row,
      counterpartNodeId,
      fromNodeId: direction === "OUT" ? account.id : counterpart.id,
      toNodeId: direction === "OUT" ? counterpart.id : account.id,
    },
  }
}

/**
 * Commit a STAGED batch (design §6 stage 5): every READY row becomes a real transaction, atomically, under the
 * batch's row lock. Refuses, writing nothing, if the batch is not STAGED or COMMITTED (InvalidImportError), if any row
 * is still PENDING (ImportNotReadyError, with the count), or if any READY row is no longer legal to commit
 * (ImportRowsIllegalError, naming every such line) — that check runs over every row before any insert, so a batch with
 * one bad row among a thousand good ones writes nothing at all.
 *
 * Once every row passes, the touched `blockNegative` ledgers (the account and every counterpart a row would move money
 * through) are checked before and after the inserts, as of the later of today and the latest row's day, exactly as any
 * other write is (`writeUnlessOverdrawn`'s pattern): an overdraft rolls the whole commit back and leaves the batch
 * STAGED. Each transaction is inserted with `occurredAt` and `amountPaise` from the row (never recomputed), a note
 * trimmed to the note limit, the idempotency key `import:<rowId>` (so a retried commit after a crash is a no-op, not a
 * double entry), and both import ids, which is what lets `insertTransactions`' ownership check (and a human reviewer)
 * see exactly which row made which transaction. A linked row's occurrence is marked POSTED with the new transaction
 * (`markPosted`); a non-empty description key teaches the counterpart just used to `upsertRule`, whether the row was
 * linked or not. The batch then moves to COMMITTED, stamped `committedAt`, with its statement bytes dropped
 * (`dropBytes`): nothing will ever re-map this batch again.
 *
 * A repeat of an already-COMMITTED batch (the exact same call again, or two racing calls under the same lock) writes
 * nothing and returns the same summary, built fresh from the batch's own COMMITTED rows (`buildCommitSummary`), which
 * is also how two concurrent commits settle on exactly one set of transactions: the second finds the batch already
 * COMMITTED once it gets the lock. Throws NotFoundError("import") for a batch that is not the user's.
 */
export async function commitBatch(userId: string, batchId: string): Promise<CommitSummary> {
  return inTransaction(async (uow) => {
    const batch = await lockBatch(userId, batchId, uow)
    if (!batch) throw new NotFoundError("import")
    if (batch.status === "COMMITTED") return buildCommitSummary(userId, batchId, batch.committedAt!, uow)
    if (batch.status !== "STAGED") {
      throw new InvalidImportError([{ field: "id", message: "This import cannot be committed." }])
    }

    const counts = await countRows(userId, batchId, uow)
    if (counts.byStatus.PENDING > 0) throw new ImportNotReadyError(counts.byStatus.PENDING)

    const account = await requireNode(userId, batch.nodeId, uow)
    const accountInfo = { id: account.id, kind: account.kind as "ASSET" | "LIABILITY" }
    const readyRows = await findRows(userId, batchId, { status: ["READY"], offset: 0, limit: IMPORT_MAX_ROWS }, uow)

    // One node lookup per distinct id for the whole commit, not one per row: a statement with many rows against the
    // same counterpart (one vendor, paid repeatedly) would otherwise re-fetch that counterpart's node every time.
    const nodeCache = new Map<string, LedgerNode>([[account.id, account]])

    // Every row is checked, and every violation collected, before anything is written: a commit either writes every
    // READY row or none of them.
    const violations: { line: number; reason: string }[] = []
    const prepared: PreparedRow[] = []
    for (const row of readyRows) {
      const result = await prepareReadyRow(userId, row, account, accountInfo, uow, nodeCache)
      if ("violation" in result) violations.push(result.violation)
      else prepared.push(result.prepared)
    }
    if (violations.length > 0) throw new ImportRowsIllegalError(violations)

    // The overdraft guard, as writeUnlessOverdrawn applies it, but for the batch as a whole rather than one write: one
    // `asOf` (the later of today and the latest row's own day), read before and after the inserts, over every node a
    // prepared row touches.
    const today = await todayFor(userId)
    let lastRowDate = today
    const touchedIds = new Set<string>([account.id])
    for (const p of prepared) {
      touchedIds.add(p.counterpartNodeId)
      const day = fromDbDate(p.row.occurredOn!)
      if (compareDates(day, lastRowDate) > 0) lastRowDate = day
    }
    const asOf = asOfFor(today, lastRowDate)
    // Every touched id was already resolved (and cached) by prepareReadyRow above, except the account itself: no
    // further lookups are needed here.
    const touchedNodes: LedgerNode[] = [account]
    for (const id of touchedIds) {
      if (id === account.id) continue
      const node = nodeCache.get(id)
      if (!node) throw new Error(`invariant: node ${id} was not resolved while preparing rows`)
      touchedNodes.push(node)
    }
    const guarded = touchedNodes.some(isGuarded)
    const before = guarded ? await balancesAt(userId, asOf, uow) : undefined

    const drafts: InsertDraft[] = prepared.map((p) => ({
      fromNodeId: p.fromNodeId,
      toNodeId: p.toNodeId,
      amountPaise: p.row.amountPaise!,
      occurredAt: fromDbDate(p.row.occurredOn!),
      note: noteFromDescription(p.row.description),
      idempotencyKey: `import:${p.row.id}`,
      importBatchId: batchId,
      importRowId: p.row.id,
    }))
    const inserted = prepared.length === 0 ? [] : await insertTransactions(userId, drafts, undefined, uow)

    if (guarded) assertNoOverdraft(touchedNodes, await balancesAt(userId, asOf, uow), before)

    await markRowsCommitted(
      userId,
      prepared.map((p, i) => ({ rowId: p.row.id, transactionId: inserted[i].id })),
      uow,
    )

    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i]
      if (p.row.occurrenceId === null) continue
      const posted = await markPosted(userId, p.row.occurrenceId, inserted[i].id, uow)
      // Re-validated as PENDING just above, under the batch's lock, in the same database transaction: a null here
      // means something else changed the occurrence in the gap between that read and this write (no lock is held on
      // the occurrence itself). That cannot be squared with "every row is legal", so the whole commit is refused, the
      // same as a row found illegal up front, rather than silently posting a transaction with no occurrence to show
      // for it.
      if (!posted) throw new ImportRowsIllegalError([{ line: p.row.line, reason: "The linked recurring occurrence changed while this import was being committed." }])
    }

    for (const p of prepared) {
      if (p.row.descriptionKey) {
        await upsertRule(userId, { direction: p.row.direction!, descriptionKey: p.row.descriptionKey, nodeId: p.counterpartNodeId }, uow)
      }
    }

    const committedAt = new Date()
    const updated = await transitionBatch(userId, batchId, { from: ["STAGED"], to: "COMMITTED", committedAt, dropBytes: true }, uow)
    if (!updated) throw new NotFoundError("import")

    return buildCommitSummary(userId, batchId, committedAt, uow)
  }, { timeout: COMMIT_TRANSACTION_TIMEOUT_MS })
}

/**
 * Reverse a COMMITTED batch (design §6 stage 5): every live transaction it created is soft-deleted and any occurrence
 * it posted is reopened to PENDING with its link cleared, under the batch's row lock, in one database transaction.
 * `ImportRow` is untouched: a committed row keeps its `transactionId`, which stays a valid foreign key because the
 * transaction is soft-deleted, not removed (the `ImportRow_status_committed_has_transaction_and_counterpart` CHECK
 * constraint is never at risk). Not guarded against an overdraft: reversal only ever raises a balance back toward what
 * it was before the commit, never below zero.
 *
 * A second reversal of an already-REVERSED batch is a no-op, returning `{ reversed: 0, reopened: 0 }`: only a
 * COMMITTED batch is reversible, so a STAGED or DISCARDED one throws InvalidImportError. Throws NotFoundError("import")
 * for a batch that is not the user's.
 */
export async function reverseBatch(userId: string, batchId: string): Promise<{ reversed: number; reopened: number }> {
  return inTransaction(async (uow) => {
    const batch = await lockBatch(userId, batchId, uow)
    if (!batch) throw new NotFoundError("import")
    if (batch.status === "REVERSED") return { reversed: 0, reopened: 0 }
    if (batch.status !== "COMMITTED") {
      throw new InvalidImportError([{ field: "id", message: "This import cannot be reversed." }])
    }

    const transactionIds = await softDeleteByBatch(userId, batchId, uow)
    const reopened = await reopenPostedByTransactions(userId, transactionIds, uow)
    const result = await transitionBatch(userId, batchId, { from: ["COMMITTED"], to: "REVERSED", reversedAt: new Date() }, uow)
    if (!result) throw new NotFoundError("import")

    return { reversed: transactionIds.length, reopened }
  })
}

// The loaders the import pages (Task 10-11) read through: a list of every batch, the new-import form's accounts and
// profiles, and one batch's page (its view, plus a committed or reversed batch's summary). Reads only; nothing here
// writes or takes the row lock.

/** Every batch of the user, newest first, with its account's name alongside. */
export async function loadBatchList(userId: string): Promise<BatchView[]> {
  const [batches, nodes] = await Promise.all([findBatches(userId), listAllNodes(userId, ["ASSET", "LIABILITY"])])
  const nameById = new Map(nodes.map((node) => [node.id, node.name]))
  return batches.map((batch) => toBatchView(batch, nameById.get(batch.nodeId) ?? "Unknown account"))
}

/** The new-import form: every live asset or liability account (design call 3: investments are not importable) and the
 * user's saved mapping profiles. */
export async function loadNewImport(
  userId: string,
): Promise<{ accounts: { id: string; name: string; kind: "ASSET" | "LIABILITY" }[]; profiles: { id: string; name: string; nodeId: string | null }[] }> {
  const [nodes, profiles] = await Promise.all([listAllNodes(userId, ["ASSET", "LIABILITY"]), findProfiles(userId)])
  const accounts = nodes
    .filter((node) => node.archivedAt === null)
    .map((node) => ({ id: node.id, name: node.name, kind: node.kind as "ASSET" | "LIABILITY" }))
  return { accounts, profiles: profiles.map((profile) => ({ id: profile.id, name: profile.name, nodeId: profile.nodeId })) }
}

/**
 * One batch's page: its view, and, once it has been committed, its commit summary (null before that). A discarded
 * batch is treated as gone, the same as a foreign one (NotFoundError("import")): nothing at `/import/<id>` should show
 * for either. A reversed batch still carries its summary — `buildCommitSummary` reads the same COMMITTED import rows
 * either way, since reversing a batch deletes its transactions but never changes its rows' own status (Task 8).
 */
export async function loadBatchPage(userId: string, batchId: string): Promise<{ batch: BatchView; summary: CommitSummary | null }> {
  const batch = await findBatchById(userId, batchId)
  if (!batch || batch.status === "DISCARDED") throw new NotFoundError("import")
  const node = await requireNode(userId, batch.nodeId)
  const view = toBatchView(batch, node.name)
  if (batch.status !== "COMMITTED" && batch.status !== "REVERSED") return { batch: view, summary: null }
  const summary = await buildCommitSummary(userId, batchId, batch.committedAt!)
  return { batch: view, summary }
}
