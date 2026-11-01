import type { ImportBatchStatus, ImportRowStatus } from "@prisma/client"
import { fromDbDate } from "@/domain/calendar-date"
import type { ImportDirection } from "@/domain/import-map"
import type { LedgerKind } from "@/domain/ledger-kind"
import { serialisePaise } from "@/lib/serialise"

// A batch as it crosses to the browser. Not the repository's row: `fileBytes` is never on it (the repository already
// omits it), and `createdAt`/`committedAt`/`reversedAt` are ISO-8601 strings, not Dates, so the view survives
// JSON.stringify unchanged. `accountName` is read alongside the batch (the repository's own row only has `nodeId`),
// since a page listing batches has no other way to say whose statement this is. No server imports: a client page can
// import the type.

export interface BatchView {
  id: string
  nodeId: string
  accountName: string
  fileName: string
  fileSize: number
  status: ImportBatchStatus
  rowCount: number
  createdAt: string
  committedAt: string | null
  reversedAt: string | null
}

/** The fields of a stored batch (the repository's `BatchView`, bytes already left off) that this view needs. */
export interface BatchRow {
  id: string
  nodeId: string
  fileName: string
  fileSize: number
  status: ImportBatchStatus
  rowCount: number
  createdAt: Date
  committedAt: Date | null
  reversedAt: Date | null
}

export function toBatchView(batch: BatchRow, accountName: string): BatchView {
  return {
    id: batch.id,
    nodeId: batch.nodeId,
    accountName,
    fileName: batch.fileName,
    fileSize: batch.fileSize,
    status: batch.status,
    rowCount: batch.rowCount,
    createdAt: batch.createdAt.toISOString(),
    committedAt: batch.committedAt === null ? null : batch.committedAt.toISOString(),
    reversedAt: batch.reversedAt === null ? null : batch.reversedAt.toISOString(),
  }
}

// The review screen (design §6 stage 4): one page of a staged batch's rows, filtered and counted, with what each row
// may be decided against. Built on the server (import-service.ts); the types live here, server-import-free, so a
// client page can import them.

export type ReviewFilter = "all" | "pending" | "duplicates" | "errors" | "ready" | "skipped"
export const REVIEW_PAGE_SIZE = 50

export interface ReviewRowView {
  id: string
  line: number
  status: ImportRowStatus
  errorReason: string | null
  occurredOn: string | null
  amountPaise: string | null
  direction: ImportDirection | null
  description: string | null
  descriptionKey: string | null
  counterpartNodeId: string | null
  /** The live transaction this row probably repeats, as it reads today; null once it no longer does (e.g. deleted). */
  duplicate: { transactionId: string; occurredAt: string; amountPaise: string; note: string | null; otherLedgerName: string } | null
  /** The pending recurring occurrence this row was matched to; null once it no longer resolves (e.g. the rule was deleted). */
  occurrence: { id: string; ruleName: string; dueOn: string; otherNodeId: string } | null
  raw: string[]
}

export interface ReviewScreen {
  batch: BatchView
  account: { id: string; name: string; kind: "ASSET" | "LIABILITY" }
  filter: ReviewFilter
  page: number
  pageCount: number
  counts: { pending: number; ready: number; skipped: number; errored: number; duplicates: number; linked: number }
  rows: ReviewRowView[]
  ledgers: { id: string; name: string; kind: LedgerKind; archived: boolean }[]
  canCommit: boolean
}

/** The fields of a stored row (the repository's `ImportRow`) that building a `ReviewRowView` needs. */
export interface ReviewRow {
  id: string
  line: number
  status: ImportRowStatus
  errorReason: string | null
  occurredOn: Date | null
  amountPaise: bigint | null
  direction: ImportDirection | null
  description: string | null
  descriptionKey: string | null
  counterpartNodeId: string | null
  raw: string[]
}

/**
 * One row's view: the row's own fields, converted (paise to text, the date to a string), alongside its duplicate and
 * occurrence sub-views, which the caller has already resolved (a lookup each, against today's data).
 */
export function toReviewRowView(
  row: ReviewRow,
  duplicate: ReviewRowView["duplicate"],
  occurrence: ReviewRowView["occurrence"],
): ReviewRowView {
  return {
    id: row.id,
    line: row.line,
    status: row.status,
    errorReason: row.errorReason,
    occurredOn: row.occurredOn === null ? null : fromDbDate(row.occurredOn),
    amountPaise: row.amountPaise === null ? null : serialisePaise(row.amountPaise),
    direction: row.direction,
    description: row.description,
    descriptionKey: row.descriptionKey,
    counterpartNodeId: row.counterpartNodeId,
    duplicate,
    occurrence,
    raw: row.raw,
  }
}
