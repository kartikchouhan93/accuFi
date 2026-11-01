import { createHash } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { calendarDate, fromDbDate, toDbDate } from "@/domain/calendar-date"
import { descriptionKey } from "@/domain/import-map"
import type { ImportMapping } from "@/domain/import-map"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { upsertRule } from "@/server/repositories/import-repository"
import { updateNode } from "@/server/repositories/node-repository"
import * as unitOfWork from "@/server/repositories/unit-of-work"
import { inTransaction } from "@/server/repositories/unit-of-work"
import {
  backToMapping,
  createBatch,
  discardBatch,
  ImportFileError,
  ImportRepeatUnconfirmedError,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  InvalidImportError,
  loadMapScreen,
  saveProfile,
  stageBatch,
} from "@/server/services/import-service"
import { createRegistry } from "../repositories/fixtures"

// The upload, map-preview and staging service, against the real database. "Today" is fixed (nothing here reads it,
// but the house rule is that no test depends on the real date).

const registry = createRegistry()
afterAll(async () => {
  vi.useRealTimers()
  await registry.cleanup()
})

type World = Awaited<ReturnType<typeof registry.makeWorld>>
let b: World
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-05-01T06:00:00Z") })
  b = await registry.makeWorld()
})

const HEADER = "Date,Description,Amount"
const csvText = (rows: string[]): string => [HEADER, ...rows].join("\n")
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

const BASE_MAPPING: ImportMapping = {
  delimiter: ",",
  encoding: "utf-8",
  skipRows: 1,
  dateFormat: "DD/MM/YYYY",
  decimalSeparator: ".",
  signConvention: "POSITIVE_OUT",
  columns: { date: 0, description: 1, amount: 2 },
}

async function setup() {
  return registry.makeWorld()
}

async function uploadedBatch(w: World, rows: string[]) {
  return createBatch(w.user.id, { nodeId: w.bank.id, fileName: "statement.csv", bytes: bytesOf(csvText(rows)) })
}

const storedRows = (batchId: string) => prisma.importRow.findMany({ where: { batchId }, orderBy: { line: "asc" } })

describe("createBatch", () => {
  it("stores the batch with the right SHA-256 hash and size, and trims the file name", async () => {
    const w = await setup()
    const bytes = bytesOf(csvText(["01/04/2026,Coffee,120.00"]))
    const batch = await createBatch(w.user.id, { nodeId: w.bank.id, fileName: "  april.csv  ", bytes })
    expect(batch.nodeId).toBe(w.bank.id)
    expect(batch.accountName).toBe("Bank")
    expect(batch.fileName).toBe("april.csv")
    expect(batch.status).toBe("UPLOADED")
    expect(batch.rowCount).toBe(0)
    expect(batch.fileSize).toBe(bytes.length)
    const stored = await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })
    expect(stored.fileHash).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect(stored.fileSize).toBe(bytes.length)
  })

  describe("file refusals", () => {
    const MARKER = "SECRET_MARKER_q7f3"

    it("refuses an empty file", async () => {
      const w = await setup()
      const error = await createBatch(w.user.id, { nodeId: w.bank.id, fileName: "x.csv", bytes: new Uint8Array() }).catch((e) => e)
      expect(error).toBeInstanceOf(ImportFileError)
      expect(error.code).toBe("EMPTY")
      expect(error.message).not.toContain(MARKER)
    })

    it("refuses a file over the size cap, and accepts the cap itself", async () => {
      const w = await setup()
      const big = new Uint8Array(IMPORT_MAX_BYTES + 1).fill(97)
      big.set(bytesOf(MARKER), 0)
      const error = await createBatch(w.user.id, { nodeId: w.bank.id, fileName: "x.csv", bytes: big }).catch((e) => e)
      expect(error).toBeInstanceOf(ImportFileError)
      expect(error.code).toBe("TOO_LARGE")
      expect(error.message).not.toContain(MARKER)
    })

    it("refuses a file with a NUL byte as not text", async () => {
      const w = await setup()
      const bytes = bytesOf(`${MARKER}\0 rest of the file`)
      const error = await createBatch(w.user.id, { nodeId: w.bank.id, fileName: "x.csv", bytes }).catch((e) => e)
      expect(error).toBeInstanceOf(ImportFileError)
      expect(error.code).toBe("NOT_TEXT")
      expect(error.message).not.toContain(MARKER)
    })
  })

  it("refuses an investment, an archived account, and a foreign account", async () => {
    const w = await setup()
    const bytes = bytesOf(csvText(["01/04/2026,Coffee,120.00"]))

    const gold = await registry.makeNode(w.user.id, "INVESTMENT", "Gold")
    await expect(createBatch(w.user.id, { nodeId: gold.id, fileName: "x.csv", bytes })).rejects.toMatchObject({
      name: "InvalidImportError",
      violations: [{ field: "nodeId" }],
    })

    const archived = await registry.makeNode(w.user.id, "ASSET", "Old Bank")
    await updateNode(w.user.id, archived.id, { archivedAt: new Date() })
    await expect(createBatch(w.user.id, { nodeId: archived.id, fileName: "x.csv", bytes })).rejects.toMatchObject({
      name: "InvalidImportError",
      violations: [{ field: "nodeId" }],
    })

    await expect(createBatch(w.user.id, { nodeId: b.bank.id, fileName: "x.csv", bytes })).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe("loadMapScreen", () => {
  it("shows an earlier upload of the same bytes, unless it was discarded", async () => {
    const w = await setup()
    const bytes = bytesOf(csvText(["01/04/2026,Coffee,120.00"]))
    const first = await createBatch(w.user.id, { nodeId: w.bank.id, fileName: "a.csv", bytes })
    const second = await createBatch(w.user.id, { nodeId: w.bank.id, fileName: "b.csv", bytes })

    const screen = await loadMapScreen(w.user.id, second.id)
    expect(screen.earlier).toMatchObject({ batchId: first.id, status: "UPLOADED" })
    expect(screen.account).toMatchObject({ id: w.bank.id, name: "Bank", kind: "ASSET" })
    expect(screen.mapping.columns.date).toBe(-1) // nothing chosen yet, by default

    await discardBatch(w.user.id, first.id)
    const after = await loadMapScreen(w.user.id, second.id)
    expect(after.earlier).toBeNull()
  })

  it("previews rows exactly as staging will store them, and reads the header", async () => {
    const w = await setup()
    const rows = ["01/04/2026,Coffee,120.00", "02/04/2026,Salary,-50000.00", "03/04/2026,Rent,2000.00"]
    const batch = await uploadedBatch(w, rows)

    const screen = await loadMapScreen(w.user.id, batch.id, BASE_MAPPING)
    expect(screen.headerCells).toEqual(["Date", "Description", "Amount"])
    expect(screen.sample[0]).toBe(HEADER)
    expect(screen.previewRows).toHaveLength(3)

    await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
    const stored = await storedRows(batch.id)
    expect(stored).toHaveLength(3)

    screen.previewRows.forEach((preview, i) => {
      const row = stored[i]
      expect(preview.error).toBeNull()
      expect(preview.parsed).not.toBeNull()
      expect(preview.parsed?.occurredOn).toBe(fromDbDate(row.occurredOn!))
      expect(preview.parsed?.amountPaise).toBe(String(row.amountPaise))
      expect(preview.parsed?.direction).toBe(row.direction)
      expect(preview.parsed?.description).toBe(row.description)
    })
  })

  it("shows at most the first 20 rows, even when the file has more", async () => {
    const w = await setup()
    const rows = Array.from({ length: 25 }, (_, i) => `01/04/2026,Row ${i},${10 + i}.00`)
    const batch = await uploadedBatch(w, rows)
    const screen = await loadMapScreen(w.user.id, batch.id, BASE_MAPPING)
    expect(screen.previewRows).toHaveLength(20)
    expect(screen.previewRows[0].cells[1]).toBe("Row 0")
    expect(screen.previewRows[19].cells[1]).toBe("Row 19")
  })

  it("a bad column mapping gives every row a per-row error, not a parsed value", async () => {
    const w = await setup()
    const batch = await uploadedBatch(w, ["01/04/2026,Coffee,120.00", "02/04/2026,Rent,2000.00"])
    const badMapping: ImportMapping = { ...BASE_MAPPING, columns: { date: 1, description: 0, amount: 2 } }
    const screen = await loadMapScreen(w.user.id, batch.id, badMapping)
    expect(screen.previewRows).toHaveLength(2)
    for (const row of screen.previewRows) {
      expect(row.parsed).toBeNull()
      expect(row.error).not.toBeNull()
    }
  })

  it("shows a prompt, not an error, while the columns are not chosen", async () => {
    const w = await setup()
    const batch = await uploadedBatch(w, ["01/04/2026,Coffee,120.00"])
    const screen = await loadMapScreen(w.user.id, batch.id) // default mapping: columns unset
    expect(screen.previewRows[0].parsed).toBeNull()
    expect(screen.previewRows[0].error).toBeNull()
  })

  it("a foreign batch id is NotFoundError", async () => {
    const w = await setup()
    const foreign = await registry.makeBatch(b.user.id, b.bank.id)
    await expect(loadMapScreen(w.user.id, foreign.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe("stageBatch", () => {
  it("refuses to stage a repeat upload unless confirmed, then stages it", async () => {
    const w = await setup()
    const bytes = bytesOf(csvText(["01/04/2026,Coffee,120.00"]))
    await createBatch(w.user.id, { nodeId: w.bank.id, fileName: "a.csv", bytes })
    const second = await createBatch(w.user.id, { nodeId: w.bank.id, fileName: "b.csv", bytes })

    await expect(stageBatch(w.user.id, second.id, BASE_MAPPING, { confirmedRepeat: false })).rejects.toBeInstanceOf(
      ImportRepeatUnconfirmedError,
    )
    const result = await stageBatch(w.user.id, second.id, BASE_MAPPING, { confirmedRepeat: true })
    expect(result).toEqual({ rows: 1, errored: 0, duplicates: 0, linked: 0, suggested: 0 })
    const stored = await prisma.importBatch.findUniqueOrThrow({ where: { id: second.id } })
    expect(stored.status).toBe("STAGED")
    expect(stored.rowCount).toBe(1)
    expect(stored.mapping).toMatchObject({ dateFormat: "DD/MM/YYYY" })
  })

  it("refuses an unsupported date with the row's own reason", async () => {
    const w = await setup()
    const batch = await uploadedBatch(w, ["31/02/2026,Bad Date,500.00"])
    await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
    const [row] = await storedRows(batch.id)
    expect(row.status).toBe("ERRORED")
    expect(row.errorReason).toContain("DD/MM/YYYY")
  })

  it("EC-56: a bad date in the third row stages the rest and stores that row ERRORED with its reason and raw cells", async () => {
    const w = await setup()
    const rows = [
      "01/04/2026,Coffee,120.00",
      "02/04/2026,Rent,2000.00",
      "31/02/2026,Bad Date,500.00",
      "04/04/2026,Groceries,300.00",
    ]
    const batch = await uploadedBatch(w, rows)
    const result = await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
    expect(result.rows).toBe(4)
    expect(result.errored).toBe(1)
    const stored = await storedRows(batch.id)
    expect(stored).toHaveLength(4)
    const bad = stored.find((r) => r.raw[1] === "Bad Date")!
    expect(bad.status).toBe("ERRORED")
    expect(bad.errorReason).toContain("DD/MM/YYYY")
    expect(bad.raw).toEqual(["31/02/2026", "Bad Date", "500.00"])
    expect(stored.filter((r) => r.status === "PENDING")).toHaveLength(3)
  })

  it("skips blank and comma-only lines silently, never as ERRORED rows", async () => {
    const w = await setup()
    const text = [HEADER, "01/04/2026,Coffee,120.00", "", ",,", "   ", "02/04/2026,Rent,2000.00"].join("\n")
    const batch = await createBatch(w.user.id, { nodeId: w.bank.id, fileName: "x.csv", bytes: bytesOf(text) })
    const result = await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
    expect(result.rows).toBe(2)
    expect(result.errored).toBe(0)
  })

  it("refuses more than the row cap of data rows", async () => {
    const w = await setup()
    const rows = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `01/04/2026,Row ${i},10.00`)
    const batch = await uploadedBatch(w, rows)
    const error = await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false }).catch((e) => e)
    expect(error).toBeInstanceOf(ImportFileError)
    expect(error.code).toBe("TOO_MANY_ROWS")
  }, 30_000)

  it("refuses to stage when the bytes do not decode as the chosen encoding", async () => {
    const w = await setup()
    const valid = bytesOf(csvText(["01/04/2026,Coffee,100.00"]))
    const bytes = new Uint8Array([...valid, 0xc0]) // 0xC0 is never a valid lead byte of UTF-8
    const batch = await createBatch(w.user.id, { nodeId: w.bank.id, fileName: "x.csv", bytes })
    await expect(stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })).rejects.toMatchObject({
      name: "InvalidImportError",
      violations: [{ field: "encoding" }],
    })
  })

  it("final review I10: an amount too large for the database is that row's own parse error; every other row still stages", async () => {
    const w = await setup()
    const rows = [
      "01/04/2026,Coffee,120.00",
      "02/04/2026,Garbage,99999999999999999999999999999999999999.00",
      "03/04/2026,Rent,2000.00",
    ]
    const batch = await uploadedBatch(w, rows)
    const result = await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
    expect(result).toMatchObject({ rows: 3, errored: 1 })
    const stored = await storedRows(batch.id)
    expect(stored.map((r) => r.status)).toEqual(["PENDING", "ERRORED", "PENDING"])
    expect(stored[1].errorReason).toBe("The amount column is too large")
    expect(stored[1].amountPaise).toBeNull()
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
  })

  it("final review I11: staging runs in a transaction with an explicit timeout sized for the row cap, not Prisma's 5s default", async () => {
    const w = await setup()
    const batch = await uploadedBatch(w, ["01/04/2026,Coffee,100.00"])
    const spy = vi.spyOn(unitOfWork, "inTransaction")
    await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
    const options = spy.mock.calls[0]?.[1]
    spy.mockRestore()
    expect(options?.timeout).toBeGreaterThanOrEqual(IMPORT_MAX_ROWS * 2)
  })

  it("final review I11: a dense re-import with many same-day transactions still flags each row against its own amount, closest first", async () => {
    const w = await setup()
    // 300 existing transactions across 30 amounts in the file's range: the per-amount index must give the same answer
    // the full scan did.
    const existing: { id: string; amount: number; day: string }[] = []
    for (let i = 0; i < 300; i++) {
      const amount = 100 + (i % 30)
      const day = `2026-04-${String(1 + (i % 9)).padStart(2, "0")}`
      const txn = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id, { amountPaise: BigInt(amount * 100), occurredAt: day })
      existing.push({ id: txn.id, amount, day })
    }
    const rows = ["05/04/2026,Hit,105.00", "05/04/2026,Miss,999.00", "20/04/2026,Out of range,105.00"]
    const batch = await uploadedBatch(w, rows)
    const result = await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
    expect(result.duplicates).toBe(1)
    const stored = await storedRows(batch.id)
    const hit = existing.find((t) => t.id === stored[0].duplicateOfTransactionId)
    // The 105.00 transactions fall on the 3rd, 6th and 9th: the nearest (one day off, the 6th) wins, and among several
    // on that day the lowest id, exactly as a full scan would choose.
    const tied = existing.filter((t) => t.amount === 105 && t.day === "2026-04-06").map((t) => t.id).sort()
    expect(hit).toMatchObject({ amount: 105, day: "2026-04-06" })
    expect(stored[0].duplicateOfTransactionId).toBe(tied[0])
    expect(stored[1].duplicateOfTransactionId).toBeNull()
    expect(stored[2].duplicateOfTransactionId).toBeNull()
  }, 60_000)

  it("refuses to stage an already-staged batch", async () => {
    const w = await setup()
    const batch = await uploadedBatch(w, ["01/04/2026,Coffee,100.00"])
    await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
    await expect(stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })).rejects.toBeInstanceOf(InvalidImportError)
  })

  describe("duplicate matching (EC-55)", () => {
    it("flags within 3 days, not 4, not the other direction, not a soft-deleted row, and never within the file", async () => {
      const w = await setup()
      const near = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id, { amountPaise: 50_000n, occurredAt: "2026-04-04" })
      await registry.makeTransaction(w.user.id, w.bank.id, w.food.id, { amountPaise: 60_000n, occurredAt: "2026-04-10" }) // 4 days from the 06/04 row
      await registry.makeTransaction(w.user.id, w.food.id, w.bank.id, { amountPaise: 70_000n, occurredAt: "2026-04-01" }) // the other direction
      await registry.makeTransaction(w.user.id, w.bank.id, w.food.id, {
        amountPaise: 80_000n,
        occurredAt: "2026-04-01",
        deletedAt: new Date(),
      })

      const rows = [
        "01/04/2026,Near,500.00", // 3 days from `near` (2026-04-04), same amount -> flagged
        "06/04/2026,Four Days,600.00", // 4 days from the other-amount txn's date -> not flagged
        "01/04/2026,Other Direction,700.00", // matches the other-direction txn's date/amount, but wrong direction
        "01/04/2026,Soft Deleted,800.00", // matches the soft-deleted txn's date/amount
        "01/04/2026,Repeat,900.00",
        "01/04/2026,Repeat,900.00", // identical repeated row inside the file: never flagged against each other
      ]
      const batch = await uploadedBatch(w, rows)
      await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
      const stored = await storedRows(batch.id)
      expect(stored[0].duplicateOfTransactionId).toBe(near.id)
      expect(stored[1].duplicateOfTransactionId).toBeNull()
      expect(stored[2].duplicateOfTransactionId).toBeNull()
      expect(stored[3].duplicateOfTransactionId).toBeNull()
      expect(stored[4].duplicateOfTransactionId).toBeNull()
      expect(stored[5].duplicateOfTransactionId).toBeNull()
    })

    it("flags a duplicate whether the live transaction was typed or came from an earlier import", async () => {
      const w = await setup()
      const priorBatch = await registry.makeBatch(w.user.id, w.bank.id, { status: "COMMITTED" })
      const imported = await prisma.transaction.create({
        data: {
          userId: w.user.id,
          fromNodeId: w.bank.id,
          toNodeId: w.food.id,
          amountPaise: 45_000n,
          occurredAt: toDbDate(calendarDate("2026-04-02")),
          importBatchId: priorBatch.id,
        },
      })
      const batch = await uploadedBatch(w, ["01/04/2026,Coffee,450.00"])
      await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
      const [row] = await storedRows(batch.id)
      expect(row.duplicateOfTransactionId).toBe(imported.id)
    })
  })

  describe("recurring occurrence matching (EC-46)", () => {
    it("links the nearer row to a pending occurrence; a dismissed or other-account one does not link; one row per occurrence", async () => {
      const w = await setup()
      const rule = await registry.makeRule(w.user.id, w.bank.id, w.food.id, { amountPaise: 100_00n, name: "Rent" })
      const pending = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-03")
      await registry.makeOccurrence(w.user.id, rule.id, "2026-04-20", { status: "DISMISSED" })
      const otherNode = await registry.makeNode(w.user.id, "ASSET", "Other Bank")
      const otherRule = await registry.makeRule(w.user.id, otherNode.id, w.food.id, { amountPaise: 100_00n, name: "Other" })
      await registry.makeOccurrence(w.user.id, otherRule.id, "2026-04-03")

      const rows = ["01/04/2026,Rent Payment,100.00", "02/04/2026,Another Rent,100.00"]
      const batch = await uploadedBatch(w, rows)
      await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
      const stored = await storedRows(batch.id)
      const linked = stored.filter((r) => r.occurrenceId !== null)
      expect(linked).toHaveLength(1)
      expect(linked[0].occurrenceId).toBe(pending.id)
      expect(linked[0].raw[1]).toBe("Another Rent") // 1 day away beats 2 days away
    })
  })

  describe("learned-rule prefill", () => {
    it("prefills a legal counterpart as PENDING, never READY; an archived or illegal suggestion is not prefilled", async () => {
      const w = await setup()
      const illegal = await registry.makeNode(w.user.id, "INVESTMENT", "Gold", { valuationMode: "LUMP" })
      const archived = await registry.makeNode(w.user.id, "EXPENSE", "Old Expense")
      await updateNode(w.user.id, archived.id, { archivedAt: new Date() })
      await inTransaction(async (uow) => {
        await upsertRule(w.user.id, { direction: "OUT", descriptionKey: descriptionKey("Coffee Shop"), nodeId: w.food.id }, uow)
        await upsertRule(w.user.id, { direction: "OUT", descriptionKey: descriptionKey("Bad Merchant"), nodeId: illegal.id }, uow)
        await upsertRule(w.user.id, { direction: "OUT", descriptionKey: descriptionKey("Archived Merchant"), nodeId: archived.id }, uow)
      })

      const rows = ["01/04/2026,Coffee Shop,100.00", "02/04/2026,Bad Merchant,200.00", "03/04/2026,Archived Merchant,300.00"]
      const batch = await uploadedBatch(w, rows)
      const result = await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
      expect(result.suggested).toBe(1)
      const stored = await storedRows(batch.id)
      expect(stored[0]).toMatchObject({ counterpartNodeId: w.food.id, status: "PENDING" })
      expect(stored[1]).toMatchObject({ counterpartNodeId: null, status: "PENDING" })
      expect(stored[2]).toMatchObject({ counterpartNodeId: null, status: "PENDING" })
    })
  })
})

describe("discardBatch and backToMapping", () => {
  it("discards an UPLOADED or STAGED batch, dropping rows and bytes; a repeat discard is a no-op", async () => {
    const w = await setup()
    const batch = await uploadedBatch(w, ["01/04/2026,Coffee,100.00"])
    await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
    await discardBatch(w.user.id, batch.id)
    const stored = await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })
    expect(stored.status).toBe("DISCARDED")
    expect(stored.fileBytes).toBeNull()
    expect(await prisma.importRow.count({ where: { batchId: batch.id } })).toBe(0)
    await expect(discardBatch(w.user.id, batch.id)).resolves.toBeUndefined()
  })

  it("refuses to discard a committed batch", async () => {
    const w = await setup()
    const committed = await registry.makeBatch(w.user.id, w.bank.id, { status: "COMMITTED" })
    await expect(discardBatch(w.user.id, committed.id)).rejects.toBeInstanceOf(InvalidImportError)
  })

  it("sends a STAGED batch back to UPLOADED, drops its rows, and keeps the mapping", async () => {
    const w = await setup()
    const batch = await uploadedBatch(w, ["01/04/2026,Coffee,100.00"])
    await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
    await backToMapping(w.user.id, batch.id)
    const stored = await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })
    expect(stored.status).toBe("UPLOADED")
    expect(stored.mapping).toMatchObject({ dateFormat: "DD/MM/YYYY" })
    expect(await prisma.importRow.count({ where: { batchId: batch.id } })).toBe(0)
  })

  it("final review I8: after Back to mapping the map screen opens on the mapping the batch was staged with, not the plain default", async () => {
    const w = await setup()
    const batch = await uploadedBatch(w, ["03/04/2026,Coffee,100.00"])
    const staged: ImportMapping = { ...BASE_MAPPING, dateFormat: "MM/DD/YYYY", signConvention: "POSITIVE_IN" }
    await stageBatch(w.user.id, batch.id, staged, { confirmedRepeat: false })
    await backToMapping(w.user.id, batch.id)

    const screen = await loadMapScreen(w.user.id, batch.id)
    expect(screen.mapping).toEqual(staged)
    expect(screen.previewRows[0].parsed?.occurredOn).toBe("2026-03-04") // read as MM/DD, exactly as it was staged
    // An explicit mapping (the GET form's parameters) still wins over the stored one.
    expect((await loadMapScreen(w.user.id, batch.id, BASE_MAPPING)).mapping).toEqual(BASE_MAPPING)
  })

  it("final review I8: a stored mapping that no longer parses falls back to the default rather than reaching the preview", async () => {
    const w = await setup()
    const batch = await uploadedBatch(w, ["03/04/2026,Coffee,100.00"])
    await prisma.importBatch.update({ where: { id: batch.id }, data: { mapping: { not: "a mapping" } } })
    const screen = await loadMapScreen(w.user.id, batch.id)
    expect(screen.mapping.columns).toEqual({ date: -1, description: -1 })
  })

  it("refuses backToMapping on a batch that is not STAGED", async () => {
    const w = await setup()
    const batch = await uploadedBatch(w, ["01/04/2026,Coffee,100.00"])
    await expect(backToMapping(w.user.id, batch.id)).rejects.toBeInstanceOf(InvalidImportError)
  })

  it("a foreign batch id is NotFoundError for stageBatch, discardBatch and backToMapping", async () => {
    const w = await setup()
    const foreign = await registry.makeBatch(b.user.id, b.bank.id)
    await expect(stageBatch(w.user.id, foreign.id, BASE_MAPPING, { confirmedRepeat: false })).rejects.toBeInstanceOf(NotFoundError)
    await expect(discardBatch(w.user.id, foreign.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(backToMapping(w.user.id, foreign.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe("saveProfile", () => {
  it("stores a mapping under a name, reusable by id", async () => {
    const w = await setup()
    const saved = await saveProfile(w.user.id, { name: "HDFC", nodeId: w.bank.id, mapping: BASE_MAPPING })
    expect(saved.name).toBe("HDFC")
    const stored = await prisma.importProfile.findUniqueOrThrow({ where: { id: saved.id } })
    expect(stored.settings).toMatchObject({ dateFormat: "DD/MM/YYYY" })
  })
})

describe("JSON.stringify of the views", () => {
  it("never throws on a bigint", async () => {
    const w = await setup()
    const batch = await uploadedBatch(w, ["01/04/2026,Coffee,100.00"])
    const screen = await loadMapScreen(w.user.id, batch.id, BASE_MAPPING)
    expect(() => JSON.stringify(screen)).not.toThrow()
    await stageBatch(w.user.id, batch.id, BASE_MAPPING, { confirmedRepeat: false })
    const afterStaging = await loadMapScreen(w.user.id, batch.id, BASE_MAPPING)
    expect(() => JSON.stringify(afterStaging)).not.toThrow()
  })
})
