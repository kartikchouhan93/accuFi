import type { ImportBatchStatus } from "@prisma/client"

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
