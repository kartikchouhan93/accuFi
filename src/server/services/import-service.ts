import { createHash } from "node:crypto"
import type { CounterpartRule, ImportBatchStatus, LedgerNode } from "@prisma/client"
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
import { importMappingSchema } from "@/lib/schemas/import"
import { toBatchView, type BatchView } from "@/lib/import-view"
import { serialisePaise } from "@/lib/serialise"
import { NotFoundError } from "@/server/repositories/errors"
import {
  deleteRows,
  findBatchById,
  findCounterpartRules,
  findEarlierUpload,
  findProfileById,
  findProfiles,
  insertBatch,
  insertRows,
  lockBatch,
  readBatchBytes,
  transitionBatch,
  upsertProfile,
  type RowData,
} from "@/server/repositories/import-repository"
import { findPendingForAccount, type OccurrenceWithRule } from "@/server/repositories/recurring-repository"
import { findAccountTransactions } from "@/server/repositories/transaction-repository"
import { inTransaction } from "@/server/repositories/unit-of-work"
import { lotModeOf } from "@/server/services/lot-rules"
import { listAllNodes } from "@/server/services/node-service"
import { requireNode } from "@/server/services/transaction-service"

// Stages 1 to 3 of the import (design §6): upload a file, preview it against a mapping, stage it into rows. The
// review and decide screens (stage 4) and commit/reverse (stage 5) are later tasks; everything they need comes
// through what this module stores (PENDING/ERRORED rows, the probable duplicate and recurring link, a prefilled
// counterpart) and reads back (loadMapScreen, the repository's row queries).
//
// Statement bytes never leave this file and a file's content never reaches an error message: every refusal here is a
// fixed string, never built from the cells it read.

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024
export const IMPORT_MAX_ROWS = 20_000

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
