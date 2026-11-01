import { createHash } from "node:crypto"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { calendarDate, toDbDate } from "@/domain/calendar-date"
import type { ImportMapping } from "@/domain/import-map"
import { prisma } from "@/server/db"
import { updateNode } from "@/server/repositories/node-repository"
import { IMPORT_MAX_ROWS } from "@/server/services/import-service"
import { createRegistry } from "../repositories/fixtures"

// The import Server Actions (src/app/import/actions.ts), shaped like tests/server/budgets/actions.test.ts, against the
// real database. The session is replaced (these tests care about what each action does with the answer requireUserId
// gives) and revalidatePath is a spy.

const { requireUserId, UnauthenticatedError } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), UnauthenticatedError }
})
vi.mock("@/server/auth", () => ({ requireUserId, UnauthenticatedError }))
const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath }))

const actions = await import("@/app/import/actions")

const registry = createRegistry()
afterAll(registry.cleanup)
beforeEach(() => {
  requireUserId.mockReset()
  revalidatePath.mockReset()
})

async function redirectTarget(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2]
    throw error
  }
  return null
}

// Server Actions are the boundary: their return value is serialised to the browser, where JSON.stringify would throw
// on a bigint and silently stringify a Date (crossing the boundary as the wrong shape). A plain walk catches both.
function assertPlainData(value: unknown, path = "value"): void {
  if (value === null || value === undefined) return
  if (typeof value === "bigint") throw new Error(`${path} is a bigint`)
  if (value instanceof Date) throw new Error(`${path} is a Date`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainData(item, `${path}[${index}]`))
    return
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertPlainData(item, `${path}.${key}`)
  }
}

const NOT_FOUND = "This import no longer exists. It may have been discarded in another tab."

/** A signed-in user with a bank account (ASSET) and a food expense ledger. */
async function signedInWorld() {
  const user = await registry.makeUser()
  requireUserId.mockResolvedValue(user.id)
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  const income = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  return { user, bank, food, income }
}

/** A batch belonging to a different user, so an action against it answers not_found. */
async function strangersBatch() {
  const stranger = await registry.makeUser()
  const theirs = await registry.makeNode(stranger.id, "ASSET", "Theirs")
  const batch = await registry.makeBatch(stranger.id, theirs.id)
  return { stranger, theirs, batch }
}

/** A PENDING row on `line`, OUT from the account by default; `over` overrides any field. */
const pendingRow = (
  userId: string,
  batchId: string,
  line: number,
  over: Parameters<typeof registry.makeImportRow>[3] = {},
) =>
  registry.makeImportRow(userId, batchId, line, {
    status: "PENDING",
    direction: "OUT",
    amountPaise: 10_000n,
    occurredOn: toDbDate(calendarDate("2026-04-10")),
    description: "Row",
    descriptionKey: "row",
    ...over,
  })

/** A READY row on `line`, OUT from the account to `counterpartNodeId` by default; `over` overrides any field. */
const readyRow = (
  userId: string,
  batchId: string,
  line: number,
  counterpartNodeId: string,
  over: Parameters<typeof registry.makeImportRow>[3] = {},
) =>
  registry.makeImportRow(userId, batchId, line, {
    status: "READY",
    direction: "OUT",
    amountPaise: 10_000n,
    occurredOn: toDbDate(calendarDate("2026-04-10")),
    description: "Row",
    descriptionKey: "row",
    counterpartNodeId,
    ...over,
  })

const HEADER = "Date,Description,Amount"
const csvText = (rows: string[]): string => [HEADER, ...rows].join("\n")
const bytesOf = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text))

const BASE_MAPPING: ImportMapping = {
  delimiter: ",",
  encoding: "utf-8",
  skipRows: 1,
  dateFormat: "DD/MM/YYYY",
  decimalSeparator: ".",
  signConvention: "POSITIVE_OUT",
  columns: { date: 0, description: 1, amount: 2 },
}

describe("every Server Action", () => {
  it("sends the user to /login, before reading its input, when the session is gone", async () => {
    const exported = Object.entries(actions)
    expect(exported.map(([name]) => name).sort()).toEqual([
      "applyToSimilarAction",
      "backToMappingAction",
      "commitBatchAction",
      "confirmSuggestionsAction",
      "discardBatchAction",
      "reverseBatchAction",
      "saveProfileAction",
      "stageBatchAction",
      "updateRowAction",
    ])
    for (const [name, action] of exported) {
      requireUserId.mockReset()
      requireUserId.mockImplementation(async () => {
        throw new UnauthenticatedError()
      })
      const target = await redirectTarget(() => (action as (input: unknown) => Promise<unknown>)(undefined))
      expect(target, name).toBe("/login")
      expect(requireUserId, name).toHaveBeenCalledTimes(1)
    }
  })

  it("does not swallow an error that is not an authentication failure", async () => {
    requireUserId.mockImplementation(async () => {
      throw new Error("auth backend down")
    })
    for (const [name, action] of Object.entries(actions)) {
      await expect((action as (input: unknown) => Promise<unknown>)({}), name).rejects.toThrow("auth backend down")
    }
  })

  it("answers bad input with invalid_input and writes nothing", async () => {
    await signedInWorld()
    for (const [name, action] of Object.entries(actions)) {
      revalidatePath.mockReset()
      const result = await (action as (input: unknown) => Promise<unknown>)({ junk: 1 })
      expect(result, name).toMatchObject({ ok: false, error: { code: "invalid_input" } })
      assertPlainData(result)
      expect(revalidatePath, name).not.toHaveBeenCalled()
    }
  })
})

describe("cache invalidation", () => {
  const revalidated = () => revalidatePath.mock.calls.map(([path]) => path).sort()
  const everywhere = ["/", "/budgets", "/import", "/investments", "/investments/prices", "/nodes", "/recurring", "/transactions"]

  it("invalidates /import, with every other screen wrote() covers, after a write that succeeds", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "UPLOADED" })
    const result = await actions.stageBatchAction({ id: batch.id, mapping: BASE_MAPPING, confirmedRepeat: false })
    expect(result).toMatchObject({ ok: true })
    expect(revalidated()).toEqual(everywhere)
  })
})

describe("stageBatchAction", () => {
  it("stages an UPLOADED batch's rows and answers a plain summary", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "UPLOADED" })
    const bytes = bytesOf(csvText(["01/04/2026,Coffee,120.00"]))
    const hash = createHash("sha256").update(bytes).digest("hex")
    await prisma.importBatch.update({ where: { id: batch.id }, data: { fileBytes: bytes, fileHash: hash } })
    const result = await actions.stageBatchAction({ id: batch.id, mapping: BASE_MAPPING, confirmedRepeat: false })
    expect(result).toMatchObject({ ok: true, data: { rows: 1, errored: 0 } })
    assertPlainData(result)
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
  })

  it("answers an unconfirmed repeat upload with the exact message, writing nothing", async () => {
    const w = await signedInWorld()
    const bytes = bytesOf(csvText(["01/04/2026,Coffee,120.00"]))
    const hash = createHash("sha256").update(bytes).digest("hex")
    const first = await registry.makeBatch(w.user.id, w.bank.id, { status: "UPLOADED", fileBytes: bytes, fileHash: hash })
    const second = await registry.makeBatch(w.user.id, w.bank.id, { status: "UPLOADED", fileBytes: bytes, fileHash: hash })
    const result = await actions.stageBatchAction({ id: second.id, mapping: BASE_MAPPING, confirmedRepeat: false })
    expect(result).toEqual({ ok: false, error: { code: "invalid", message: "You uploaded this exact file before. Confirm to continue." } })
    assertPlainData(result)
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("UPLOADED")
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("UPLOADED")

    const confirmed = await actions.stageBatchAction({ id: second.id, mapping: BASE_MAPPING, confirmedRepeat: true })
    expect(confirmed).toMatchObject({ ok: true })
  })

  it("answers a batch already staged with the exact invalid message", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    const result = await actions.stageBatchAction({ id: batch.id, mapping: BASE_MAPPING, confirmedRepeat: false })
    expect(result).toEqual({ ok: false, error: { code: "invalid", message: "This import has already been staged.", fieldErrors: { id: ["This import has already been staged."] } } })
    assertPlainData(result)
  })

  it("answers a file over the row cap with the exact message, writing nothing", async () => {
    const w = await signedInWorld()
    const rows = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `01/04/2026,Row ${i},10.00`)
    const bytes = bytesOf(csvText(rows))
    const hash = createHash("sha256").update(bytes).digest("hex")
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "UPLOADED", fileBytes: bytes, fileHash: hash })
    const result = await actions.stageBatchAction({ id: batch.id, mapping: BASE_MAPPING, confirmedRepeat: false })
    expect(result).toEqual({ ok: false, error: { code: "invalid", message: "That file has more than 20,000 rows." } })
    assertPlainData(result)
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("UPLOADED")
  })

  it("answers a foreign batch as not_found with the exact message, changing nothing", async () => {
    await signedInWorld()
    const { batch } = await strangersBatch()
    const result = await actions.stageBatchAction({ id: batch.id, mapping: BASE_MAPPING, confirmedRepeat: false })
    expect(result).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
    assertPlainData(result)
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
  })
})

describe("saveProfileAction", () => {
  it("saves a mapping under a name and answers its id and name", async () => {
    const w = await signedInWorld()
    const result = await actions.saveProfileAction({ name: "My bank", nodeId: w.bank.id, mapping: BASE_MAPPING })
    expect(result).toMatchObject({ ok: true, data: { name: "My bank" } })
    assertPlainData(result)
    expect(await prisma.importProfile.count({ where: { userId: w.user.id } })).toBe(1)
  })

  it("answers a foreign ledger as not_found, saying the ledger, and saves nothing", async () => {
    const w = await signedInWorld()
    const { theirs } = await strangersBatch()
    const result = await actions.saveProfileAction({ name: "My bank", nodeId: theirs.id, mapping: BASE_MAPPING })
    expect(result).toEqual({ ok: false, error: { code: "not_found", message: "That ledger was not found" } })
    assertPlainData(result)
    expect(await prisma.importProfile.count({ where: { userId: w.user.id } })).toBe(0)
  })
})

describe("discardBatchAction", () => {
  it("discards an UPLOADED batch", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "UPLOADED" })
    const result = await actions.discardBatchAction({ id: batch.id })
    expect(result).toEqual({ ok: true, data: null })
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("DISCARDED")
  })

  it("answers a batch that cannot be discarded with the exact invalid message", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "COMMITTED", committedAt: new Date() })
    const result = await actions.discardBatchAction({ id: batch.id })
    expect(result).toEqual({ ok: false, error: { code: "invalid", message: "This import cannot be discarded.", fieldErrors: { id: ["This import cannot be discarded."] } } })
    assertPlainData(result)
  })

  it("answers a foreign batch as not_found with the exact message, changing nothing", async () => {
    await signedInWorld()
    const { batch } = await strangersBatch()
    const result = await actions.discardBatchAction({ id: batch.id })
    expect(result).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
  })
})

describe("backToMappingAction", () => {
  it("sends a STAGED batch back to UPLOADED", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    const result = await actions.backToMappingAction({ id: batch.id })
    expect(result).toEqual({ ok: true, data: null })
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("UPLOADED")
  })

  it("answers a batch that is not staged with the exact invalid message", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "UPLOADED" })
    const result = await actions.backToMappingAction({ id: batch.id })
    expect(result).toEqual({ ok: false, error: { code: "invalid", message: "This import is not staged.", fieldErrors: { id: ["This import is not staged."] } } })
    assertPlainData(result)
  })

  it("answers a foreign batch as not_found with the exact message, changing nothing", async () => {
    await signedInWorld()
    const { batch } = await strangersBatch()
    const result = await actions.backToMappingAction({ id: batch.id })
    expect(result).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
  })
})

describe("updateRowAction", () => {
  it("imports a row with an explicit counterpart, answering a plain row view", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    const row = await pendingRow(w.user.id, batch.id, 1)
    const result = await actions.updateRowAction({ rowId: row.id, change: { counterpartNodeId: w.food.id, decision: "IMPORT" } })
    expect(result).toMatchObject({ ok: true, data: { id: row.id, status: "READY", counterpartNodeId: w.food.id } })
    assertPlainData(result)
  })

  it("answers a row with no counterpart to import with the exact invalid message", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    const row = await pendingRow(w.user.id, batch.id, 1)
    const result = await actions.updateRowAction({ rowId: row.id, change: { decision: "IMPORT" } })
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid", message: "Choose a counterpart before importing this row.", fieldErrors: { counterpartNodeId: ["Choose a counterpart before importing this row."] } },
    })
    assertPlainData(result)
  })

  it("answers a foreign row as not_found with the exact message, changing nothing", async () => {
    await signedInWorld()
    const { batch: theirBatch, stranger } = await strangersBatch()
    const theirRow = await pendingRow(stranger.id, theirBatch.id, 1)
    const result = await actions.updateRowAction({ rowId: theirRow.id, change: { decision: "SKIP" } })
    expect(result).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: theirRow.id } })).status).toBe("PENDING")
  })
})

describe("applyToSimilarAction", () => {
  it("copies a row's counterpart onto similar rows and answers how many changed", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    const first = await pendingRow(w.user.id, batch.id, 1, { counterpartNodeId: w.food.id })
    await pendingRow(w.user.id, batch.id, 2)
    const result = await actions.applyToSimilarAction({ rowId: first.id })
    expect(result).toEqual({ ok: true, data: 2 })
    assertPlainData(result)
  })

  it("answers a foreign row as not_found with the exact message", async () => {
    const { batch, stranger } = await strangersBatch()
    await signedInWorld()
    const theirRow = await pendingRow(stranger.id, batch.id, 1)
    const result = await actions.applyToSimilarAction({ rowId: theirRow.id })
    expect(result).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
  })
})

describe("confirmSuggestionsAction", () => {
  it("readies every suggested, non-duplicate PENDING row and answers how many changed", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    await pendingRow(w.user.id, batch.id, 1, { counterpartNodeId: w.food.id })
    await pendingRow(w.user.id, batch.id, 2)
    const result = await actions.confirmSuggestionsAction({ id: batch.id })
    expect(result).toEqual({ ok: true, data: 1 })
    assertPlainData(result)
  })

  it("answers a foreign batch as not_found with the exact message", async () => {
    await signedInWorld()
    const { batch } = await strangersBatch()
    const result = await actions.confirmSuggestionsAction({ id: batch.id })
    expect(result).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
  })
})

describe("commitBatchAction", () => {
  it("commits a STAGED batch's READY rows and answers a plain summary", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    await readyRow(w.user.id, batch.id, 1, w.food.id)
    const result = await actions.commitBatchAction({ id: batch.id })
    expect(result).toMatchObject({ ok: true, data: { imported: 1 } })
    assertPlainData(result)
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("COMMITTED")
  })

  it("answers a batch with pending rows with the exact ImportNotReadyError message", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    await pendingRow(w.user.id, batch.id, 1)
    const result = await actions.commitBatchAction({ id: batch.id })
    expect(result).toEqual({ ok: false, error: { code: "invalid", message: "1 row(s) still need a decision." } })
    assertPlainData(result)
  })

  it("answers a counterpart archived since staging with the exact ImportRowsIllegalError message", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    const shop = await registry.makeNode(w.user.id, "EXPENSE", "Shop")
    await readyRow(w.user.id, batch.id, 2, shop.id)
    await updateNode(w.user.id, shop.id, { archivedAt: new Date() })
    const result = await actions.commitBatchAction({ id: batch.id })
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid", message: "Line 2: This ledger can no longer be the counterpart of this row." },
    })
    assertPlainData(result)
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
  })

  it("joins the first five illegal lines with '; ' and names how many more when a batch has more than five", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    const reason = "This ledger can no longer be the counterpart of this row."
    for (let line = 1; line <= 6; line++) {
      const shop = await registry.makeNode(w.user.id, "EXPENSE", `Shop ${line}`)
      await readyRow(w.user.id, batch.id, line, shop.id)
      await updateNode(w.user.id, shop.id, { archivedAt: new Date() })
    }
    const result = await actions.commitBatchAction({ id: batch.id })
    const expectedMessage = [1, 2, 3, 4, 5].map((line) => `Line ${line}: ${reason}`).join("; ") + "; and 1 more"
    expect(result).toEqual({ ok: false, error: { code: "invalid", message: expectedMessage } })
    assertPlainData(result)
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
  })

  it("final review I3: answers a commit that would overdraw a blockNegative ledger as overdraft_blocked with its own message, not an unmapped error", async () => {
    const w = await signedInWorld()
    const guarded = await registry.makeNode(w.user.id, "ASSET", "Guarded", { blockNegative: true })
    const batch = await registry.makeBatch(w.user.id, guarded.id, { status: "STAGED" })
    await readyRow(w.user.id, batch.id, 1, w.food.id)
    const result = await actions.commitBatchAction({ id: batch.id })
    expect(result).toEqual({
      ok: false,
      error: {
        code: "overdraft_blocked",
        message: "Guarded does not allow a negative balance, so this would overdraw it. Nothing was imported; the import is still staged.",
      },
    })
    assertPlainData(result)
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
    expect(await prisma.transaction.count({ where: { importBatchId: batch.id } })).toBe(0)
  })

  it("final review C2: answers a duplicate recorded since staging with the line and the way forward, and the row is back in review", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    const row = await readyRow(w.user.id, batch.id, 3, w.food.id)
    const stored = await prisma.importRow.findUniqueOrThrow({ where: { id: row.id } })
    await registry.makeTransaction(w.user.id, w.bank.id, w.food.id, { amountPaise: stored.amountPaise!, occurredAt: "2026-04-11" })
    const result = await actions.commitBatchAction({ id: batch.id })
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid", message: "Line 3: A matching transaction was recorded since staging. It is back in review as a possible duplicate." },
    })
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("PENDING")
  })

  it("answers a batch that cannot be committed with the exact invalid message", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "UPLOADED" })
    const result = await actions.commitBatchAction({ id: batch.id })
    expect(result).toEqual({ ok: false, error: { code: "invalid", message: "This import cannot be committed.", fieldErrors: { id: ["This import cannot be committed."] } } })
    assertPlainData(result)
  })

  it("answers a foreign batch as not_found with the exact message, changing nothing", async () => {
    await signedInWorld()
    const { batch } = await strangersBatch()
    const result = await actions.commitBatchAction({ id: batch.id })
    expect(result).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
  })
})

describe("reverseBatchAction", () => {
  it("reverses a COMMITTED batch and answers a plain result", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    await readyRow(w.user.id, batch.id, 1, w.food.id)
    const committed = await actions.commitBatchAction({ id: batch.id })
    expect(committed).toMatchObject({ ok: true })
    const result = await actions.reverseBatchAction({ id: batch.id })
    expect(result).toEqual({ ok: true, data: { reversed: 1, reopened: 0 } })
    assertPlainData(result)
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("REVERSED")
  })

  it("answers a batch that cannot be reversed with the exact invalid message", async () => {
    const w = await signedInWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    const result = await actions.reverseBatchAction({ id: batch.id })
    expect(result).toEqual({ ok: false, error: { code: "invalid", message: "This import cannot be reversed.", fieldErrors: { id: ["This import cannot be reversed."] } } })
    assertPlainData(result)
  })

  it("answers a foreign batch as not_found with the exact message, changing nothing", async () => {
    await signedInWorld()
    const { batch } = await strangersBatch()
    const result = await actions.reverseBatchAction({ id: batch.id })
    expect(result).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
  })
})
