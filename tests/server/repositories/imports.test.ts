import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import * as repo from "@/server/repositories/import-repository"
import { inTransaction } from "@/server/repositories/unit-of-work"
import { createRegistry } from "./fixtures"

// The import repository against the real database: what a batch stores and never loads, the conditional status moves,
// the batch lock, row paging and the decisions put on rows, and the learned rules. Every foreign-user case is in
// isolation.test.ts.

const registry = createRegistry()
afterAll(registry.cleanup)

type World = Awaited<ReturnType<typeof registry.makeWorld>>
let a: World
let b: World

beforeAll(async () => {
  a = await registry.makeWorld()
  b = await registry.makeWorld()
})

let hashCounter = 0
const uniqueHash = () => (hashCounter++).toString(16).padStart(64, "0")

async function expectNotFound(promise: Promise<unknown>, entity: NotFoundError["entity"]) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error, "expected NotFoundError").toBeInstanceOf(NotFoundError)
  expect((error as NotFoundError).entity).toBe(entity)
}

function batchData(w: World, over: Partial<Parameters<typeof repo.insertBatch>[1]> = {}): Parameters<typeof repo.insertBatch>[1] {
  return { nodeId: w.bank.id, fileName: "april.csv", fileSize: 5, fileHash: uniqueHash(), fileBytes: new Uint8Array([1, 2, 3, 4, 5]), ...over }
}

function rowData(line: number, over: Partial<repo.RowData> = {}): repo.RowData {
  return {
    line,
    raw: ["2026-04-01", "coffee", "-120.00"],
    status: "PENDING",
    errorReason: null,
    occurredOn: new Date("2026-04-01T00:00:00.000Z"),
    amountPaise: 12_000n,
    direction: "OUT",
    description: "Coffee",
    descriptionKey: "coffee",
    counterpartNodeId: null,
    duplicateOfTransactionId: null,
    occurrenceId: null,
    ...over,
  }
}

describe("insertBatch and the batch reads", () => {
  it("stores the batch for the caller, UPLOADED with no rows, and never returns its bytes", async () => {
    const w = await registry.makeWorld()
    const row = await repo.insertBatch(w.user.id, batchData(w))
    expect(row.userId).toBe(w.user.id)
    expect(row.nodeId).toBe(w.bank.id)
    expect(row.status).toBe("UPLOADED")
    expect(row.rowCount).toBe(0)
    expect(row.fileSize).toBe(5)
    expect("fileBytes" in row).toBe(false)
    const read = await repo.findBatchById(w.user.id, row.id)
    expect(read).toEqual(row)
    expect("fileBytes" in read!).toBe(false)
    expect(await inTransaction((uow) => repo.findBatchById(w.user.id, row.id, uow))).toEqual(row)
    const listed = await repo.findBatches(w.user.id)
    expect(listed).toEqual([row])
    expect("fileBytes" in listed[0]).toBe(false)
    // the bytes are really stored
    expect(await prisma.importBatch.findUniqueOrThrow({ where: { id: row.id }, select: { fileBytes: true } })).toEqual({
      fileBytes: new Uint8Array([1, 2, 3, 4, 5]),
    })
  })

  it("inside a unit of work commits and rolls back with it", async () => {
    const w = await registry.makeWorld()
    await expect(
      inTransaction(async (uow) => {
        await repo.insertBatch(w.user.id, batchData(w), uow)
        throw new Error("abort")
      }),
    ).rejects.toThrow("abort")
    expect(await repo.findBatches(w.user.id)).toEqual([])
  })

  it("refuses an account that is not the user's, and a profile that is not theirs, writing nothing", async () => {
    const w = await registry.makeWorld()
    await expectNotFound(repo.insertBatch(w.user.id, batchData(w, { nodeId: b.bank.id })), "node")
    const foreign = await repo.upsertProfile(b.user.id, { name: "bank", nodeId: null, settings: {} })
    await expectNotFound(repo.insertBatch(w.user.id, batchData(w, { profileId: foreign.id })), "import")
    expect(await repo.findBatches(w.user.id)).toEqual([])
  })

  it("keeps the profile link, and findBatches lists the newest first", async () => {
    const w = await registry.makeWorld()
    const profile = await repo.upsertProfile(w.user.id, { name: "bank", nodeId: w.bank.id, settings: {} })
    const first = await registry.makeBatch(w.user.id, w.bank.id, { createdAt: new Date("2026-04-01T10:00:00Z") })
    const second = await registry.makeBatch(w.user.id, w.bank.id, { createdAt: new Date("2026-04-02T10:00:00Z") })
    const withProfile = await repo.insertBatch(w.user.id, batchData(w, { profileId: profile.id }))
    expect(withProfile.profileId).toBe(profile.id)
    expect((await repo.findBatches(w.user.id)).map((r) => r.id)).toEqual([withProfile.id, second.id, first.id])
  })

  it("readBatchBytes returns the file, and null once it was dropped or for an unknown id", async () => {
    const w = await registry.makeWorld()
    const row = await repo.insertBatch(w.user.id, batchData(w))
    expect(await repo.readBatchBytes(w.user.id, row.id)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect(await inTransaction((uow) => repo.readBatchBytes(w.user.id, row.id, uow))).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect(await repo.readBatchBytes(w.user.id, "no-such-batch")).toBeNull()
    await repo.transitionBatch(w.user.id, row.id, { from: ["UPLOADED"], to: "DISCARDED", dropBytes: true })
    expect(await repo.readBatchBytes(w.user.id, row.id)).toBeNull()
  })
})

describe("findEarlierUpload", () => {
  it("picks the most recent batch with the hash that was not discarded, and honours the exclusion", async () => {
    const w = await registry.makeWorld()
    const h = uniqueHash()
    const oldest = await registry.makeBatch(w.user.id, w.bank.id, { fileHash: h, status: "COMMITTED", createdAt: new Date("2026-04-01T00:00:00Z") })
    const middle = await registry.makeBatch(w.user.id, w.bank.id, { fileHash: h, status: "STAGED", createdAt: new Date("2026-04-02T00:00:00Z") })
    const discarded = await registry.makeBatch(w.user.id, w.bank.id, { fileHash: h, status: "DISCARDED", createdAt: new Date("2026-04-03T00:00:00Z") })
    await registry.makeBatch(w.user.id, w.bank.id, { fileHash: uniqueHash(), createdAt: new Date("2026-04-04T00:00:00Z") })

    const found = await repo.findEarlierUpload(w.user.id, h)
    expect(found?.id).toBe(middle.id)
    expect("fileBytes" in found!).toBe(false)
    expect((await repo.findEarlierUpload(w.user.id, h, middle.id))?.id).toBe(oldest.id)
    expect(discarded.id).not.toBe(found?.id)
    expect(await repo.findEarlierUpload(w.user.id, uniqueHash())).toBeNull()
  })

  it("is null when the only batch is discarded, or excluded", async () => {
    const w = await registry.makeWorld()
    const h = uniqueHash()
    await registry.makeBatch(w.user.id, w.bank.id, { fileHash: h, status: "DISCARDED" })
    expect(await repo.findEarlierUpload(w.user.id, h)).toBeNull()
    const only = await registry.makeBatch(w.user.id, w.bank.id, { fileHash: h, status: "UPLOADED" })
    expect(await repo.findEarlierUpload(w.user.id, h, only.id)).toBeNull()
  })

  it("never sees another user's batch with the same hash", async () => {
    const h = uniqueHash()
    await registry.makeBatch(b.user.id, b.bank.id, { fileHash: h })
    expect(await repo.findEarlierUpload(a.user.id, h)).toBeNull()
  })
})

describe("lockBatch", () => {
  it("returns the batch without its bytes, and null for an unknown id", async () => {
    const w = await registry.makeWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const locked = await inTransaction((uow) => repo.lockBatch(w.user.id, batch.id, uow))
    expect(locked?.id).toBe(batch.id)
    expect("fileBytes" in locked!).toBe(false)
    expect(await inTransaction((uow) => repo.lockBatch(w.user.id, "no-such-batch", uow))).toBeNull()
  })

  it("makes a second transaction wait until the first ends", async () => {
    const w = await registry.makeWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let acquired!: () => void
    const firstHasLock = new Promise<void>((resolve) => (acquired = resolve))

    const first = inTransaction(async (uow) => {
      await repo.lockBatch(w.user.id, batch.id, uow)
      acquired()
      await held
      order.push("first done")
    })
    await firstHasLock
    const second = inTransaction(async (uow) => {
      await repo.lockBatch(w.user.id, batch.id, uow)
      order.push("second locked")
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(order).toEqual([])
    } finally {
      release() // always: a failed assertion must not leave the first transaction held until Prisma's 5 s timeout
    }
    await Promise.all([first, second])
    expect(order).toEqual(["first done", "second locked"])
  })

  it("does not make a transaction on another batch wait", async () => {
    const w = await registry.makeWorld()
    const one = await registry.makeBatch(w.user.id, w.bank.id)
    const two = await registry.makeBatch(w.user.id, w.bank.id)
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let acquired!: () => void
    const firstHasLock = new Promise<void>((resolve) => (acquired = resolve))
    const first = inTransaction(async (uow) => {
      await repo.lockBatch(w.user.id, one.id, uow)
      acquired()
      await held
    })
    await firstHasLock
    try {
      expect((await inTransaction((uow) => repo.lockBatch(w.user.id, two.id, uow)))?.id).toBe(two.id)
    } finally {
      release()
    }
    await first
  })
})

describe("transitionBatch", () => {
  it("moves a batch from an allowed status and records what the change carries", async () => {
    const w = await registry.makeWorld()
    const batch = await repo.insertBatch(w.user.id, batchData(w))
    const staged = await repo.transitionBatch(w.user.id, batch.id, {
      from: ["UPLOADED", "STAGED"],
      to: "STAGED",
      mapping: { dateColumn: 0 },
      rowCount: 7,
    })
    expect(staged).toMatchObject({ id: batch.id, status: "STAGED", mapping: { dateColumn: 0 }, rowCount: 7, committedAt: null })
    expect("fileBytes" in staged!).toBe(false)
    // bytes are still there: only dropBytes removes them
    expect(await repo.readBatchBytes(w.user.id, batch.id)).not.toBeNull()
    const when = new Date("2026-05-01T12:00:00.000Z")
    const committed = await repo.transitionBatch(w.user.id, batch.id, { from: ["STAGED"], to: "COMMITTED", committedAt: when, dropBytes: true })
    expect(committed).toMatchObject({ status: "COMMITTED", committedAt: when, mapping: { dateColumn: 0 }, rowCount: 7 })
    expect(await repo.readBatchBytes(w.user.id, batch.id)).toBeNull()
    const reversedAt = new Date("2026-05-02T12:00:00.000Z")
    expect(await repo.transitionBatch(w.user.id, batch.id, { from: ["COMMITTED"], to: "REVERSED", reversedAt })).toMatchObject({
      status: "REVERSED",
      reversedAt,
      committedAt: when,
    })
  })

  it("clears the mapping when it is null, and leaves it alone when it is undefined", async () => {
    const w = await registry.makeWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "UPLOADED", mapping: { x: 1 } })
    expect((await repo.transitionBatch(w.user.id, batch.id, { from: ["UPLOADED"], to: "UPLOADED" }))?.mapping).toEqual({ x: 1 })
    expect((await repo.transitionBatch(w.user.id, batch.id, { from: ["UPLOADED"], to: "UPLOADED", mapping: null }))?.mapping).toBeNull()
  })

  it("returns null and changes nothing when the batch is in another status", async () => {
    const w = await registry.makeWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "COMMITTED" })
    const before = await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })
    expect(await repo.transitionBatch(w.user.id, batch.id, { from: ["UPLOADED", "STAGED"], to: "DISCARDED", dropBytes: true, rowCount: 99 })).toBeNull()
    expect(await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).toEqual(before)
  })

  it("lets only one of two racing moves win", async () => {
    const w = await registry.makeWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    const results = await Promise.all([
      repo.transitionBatch(w.user.id, batch.id, { from: ["STAGED"], to: "COMMITTED" }),
      repo.transitionBatch(w.user.id, batch.id, { from: ["STAGED"], to: "DISCARDED" }),
    ])
    expect(results.filter((r) => r !== null)).toHaveLength(1)
  })

  it("works inside a unit of work and rolls back with it", async () => {
    const w = await registry.makeWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    await expect(
      inTransaction(async (uow) => {
        expect(await repo.transitionBatch(w.user.id, batch.id, { from: ["STAGED"], to: "COMMITTED" }, uow)).not.toBeNull()
        throw new Error("abort")
      }),
    ).rejects.toThrow("abort")
    expect((await repo.findBatchById(w.user.id, batch.id))?.status).toBe("STAGED")
  })
})

describe("rows: insert, page, count", () => {
  async function stagedBatch() {
    const w = await registry.makeWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    return { w, batch }
  }

  it("stores rows for the caller and reads them back in line order, paged and filtered", async () => {
    const { w, batch } = await stagedBatch()
    const tx = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id)
    const rows = [
      rowData(3, { status: "READY", counterpartNodeId: w.food.id }),
      rowData(1),
      rowData(2, { duplicateOfTransactionId: tx.id }),
      rowData(5, { status: "ERRORED", errorReason: "bad date", occurredOn: null, amountPaise: null, direction: null }),
      rowData(4, { status: "SKIPPED" }),
    ]
    expect(await inTransaction((uow) => repo.insertRows(w.user.id, batch.id, rows, uow))).toBe(5)

    const all = await repo.findRows(w.user.id, batch.id, { offset: 0, limit: 50 })
    expect(all.map((r) => r.line)).toEqual([1, 2, 3, 4, 5])
    expect(all.every((r) => r.userId === w.user.id && r.batchId === batch.id)).toBe(true)
    expect(all[0]).toMatchObject({ raw: ["2026-04-01", "coffee", "-120.00"], amountPaise: 12_000n, direction: "OUT", descriptionKey: "coffee" })
    expect(all[0].occurredOn).toEqual(new Date("2026-04-01T00:00:00.000Z"))
    expect(all[4]).toMatchObject({ status: "ERRORED", errorReason: "bad date", amountPaise: null })

    expect((await repo.findRows(w.user.id, batch.id, { offset: 1, limit: 2 })).map((r) => r.line)).toEqual([2, 3])
    expect((await repo.findRows(w.user.id, batch.id, { offset: 4, limit: 10 })).map((r) => r.line)).toEqual([5])
    expect((await repo.findRows(w.user.id, batch.id, { status: ["READY", "SKIPPED"], offset: 0, limit: 10 })).map((r) => r.line)).toEqual([3, 4])
    expect((await repo.findRows(w.user.id, batch.id, { duplicatesOnly: true, offset: 0, limit: 10 })).map((r) => r.line)).toEqual([2])
    expect(
      (await repo.findRows(w.user.id, batch.id, { status: ["PENDING"], duplicatesOnly: true, offset: 0, limit: 10 })).map((r) => r.line),
    ).toEqual([2])
    expect(await repo.findRows(w.user.id, batch.id, { status: ["COMMITTED"], offset: 0, limit: 10 })).toEqual([])
    expect((await repo.findRowsForBatch(w.user.id, batch.id)).map((r) => r.line)).toEqual([1, 2, 3, 4, 5])
    expect(await inTransaction((uow) => repo.findRows(w.user.id, batch.id, { offset: 0, limit: 1 }, uow))).toHaveLength(1)
    const byId = await repo.findRowById(w.user.id, all[1].id)
    expect(byId).toEqual(all[1])
    expect(await repo.findRowById(w.user.id, "no-such-row")).toBeNull()
  })

  it("inserting nothing writes nothing, and inserting a repeated line fails as a whole", async () => {
    const { w, batch } = await stagedBatch()
    expect(await inTransaction((uow) => repo.insertRows(w.user.id, batch.id, [], uow))).toBe(0)
    await expect(inTransaction((uow) => repo.insertRows(w.user.id, batch.id, [rowData(1), rowData(1)], uow))).rejects.toThrow()
    expect(await repo.findRowsForBatch(w.user.id, batch.id)).toEqual([])
  })

  it("counts rows by status (all five present), duplicates and linked ones", async () => {
    const { w, batch } = await stagedBatch()
    const tx = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id)
    expect(await repo.countRows(w.user.id, batch.id)).toEqual({
      byStatus: { PENDING: 0, READY: 0, SKIPPED: 0, ERRORED: 0, COMMITTED: 0 },
      duplicates: 0,
      linked: 0,
    })
    await inTransaction((uow) =>
      repo.insertRows(
        w.user.id,
        batch.id,
        [
          rowData(1),
          rowData(2),
          rowData(3, { duplicateOfTransactionId: tx.id }),
          rowData(4, { status: "READY", counterpartNodeId: w.food.id, occurrenceId: "occ-1" }),
          rowData(5, { status: "ERRORED", errorReason: "bad", occurredOn: null, amountPaise: null, direction: null }),
        ],
        uow,
      ),
    )
    const counts = await repo.countRows(w.user.id, batch.id)
    expect(counts).toEqual({ byStatus: { PENDING: 3, READY: 1, SKIPPED: 0, ERRORED: 1, COMMITTED: 0 }, duplicates: 1, linked: 1 })
    expect(await inTransaction((uow) => repo.countRows(w.user.id, batch.id, uow))).toEqual(counts)
  })

  it("deleteRows removes every row of the batch and only that batch's", async () => {
    const { w, batch } = await stagedBatch()
    const other = await registry.makeBatch(w.user.id, w.bank.id)
    await registry.makeImportRow(w.user.id, batch.id, 1)
    await registry.makeImportRow(w.user.id, batch.id, 2)
    await registry.makeImportRow(w.user.id, other.id, 1)
    expect(await inTransaction((uow) => repo.deleteRows(w.user.id, batch.id, uow))).toBe(2)
    expect(await repo.findRowsForBatch(w.user.id, batch.id)).toEqual([])
    expect(await repo.findRowsForBatch(w.user.id, other.id)).toHaveLength(1)
  })
})

describe("updateRow", () => {
  async function setup(status: "STAGED" | "COMMITTED" | "UPLOADED" = "STAGED") {
    const w = await registry.makeWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status })
    return { w, batch }
  }

  it("sets the status, counterpart and occurrence of a pending row of a staged batch, and clears them with null", async () => {
    const { w, batch } = await setup()
    const row = await registry.makeImportRow(w.user.id, batch.id, 1)
    const ready = await repo.updateRow(w.user.id, row.id, { status: "READY", counterpartNodeId: w.food.id, occurrenceId: "occ-9" })
    expect(ready).toMatchObject({ id: row.id, status: "READY", counterpartNodeId: w.food.id, occurrenceId: "occ-9" })
    const back = await repo.updateRow(w.user.id, row.id, { status: "PENDING", counterpartNodeId: null, occurrenceId: null })
    expect(back).toMatchObject({ status: "PENDING", counterpartNodeId: null, occurrenceId: null })
    // an empty change leaves the row as it is
    expect(await repo.updateRow(w.user.id, row.id, {})).toEqual(back)
  })

  it("refuses a row of a batch that is not STAGED, an ERRORED row, a COMMITTED row, and an unknown row", async () => {
    const { w, batch } = await setup("UPLOADED")
    const inUploaded = await registry.makeImportRow(w.user.id, batch.id, 1)
    expect(await repo.updateRow(w.user.id, inUploaded.id, { status: "SKIPPED" })).toBeNull()
    expect((await repo.findRowById(w.user.id, inUploaded.id))?.status).toBe("PENDING")

    const staged = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    const errored = await registry.makeImportRow(w.user.id, staged.id, 1, { status: "ERRORED", errorReason: "bad date" })
    expect(await repo.updateRow(w.user.id, errored.id, { status: "SKIPPED" })).toBeNull()
    expect(await prisma.importRow.findUniqueOrThrow({ where: { id: errored.id } })).toEqual(errored)

    const tx = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id)
    const committed = await registry.makeImportRow(w.user.id, staged.id, 2, { status: "COMMITTED", counterpartNodeId: w.food.id, transactionId: tx.id })
    expect(await repo.updateRow(w.user.id, committed.id, { status: "SKIPPED" })).toBeNull()
    expect(await prisma.importRow.findUniqueOrThrow({ where: { id: committed.id } })).toEqual(committed)

    expect(await repo.updateRow(w.user.id, "no-such-row", { status: "SKIPPED" })).toBeNull()
  })

  it("refuses a counterpart that is not the user's ledger", async () => {
    const { w, batch } = await setup()
    const row = await registry.makeImportRow(w.user.id, batch.id, 1)
    await expectNotFound(repo.updateRow(w.user.id, row.id, { counterpartNodeId: b.food.id }), "node")
    expect((await repo.findRowById(w.user.id, row.id))?.counterpartNodeId).toBeNull()
  })
})

describe("updateRowsWhereSame", () => {
  it("touches only the rows that match direction, description key and status in a staged batch", async () => {
    const w = await registry.makeWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const otherBatch = await registry.makeBatch(w.user.id, w.bank.id)
    const hit1 = await registry.makeImportRow(w.user.id, batch.id, 1, { direction: "OUT", descriptionKey: "coffee" })
    const hit2 = await registry.makeImportRow(w.user.id, batch.id, 2, { direction: "OUT", descriptionKey: "coffee" })
    const otherDirection = await registry.makeImportRow(w.user.id, batch.id, 3, { direction: "IN", descriptionKey: "coffee" })
    const otherKey = await registry.makeImportRow(w.user.id, batch.id, 4, { direction: "OUT", descriptionKey: "tea" })
    const skipped = await registry.makeImportRow(w.user.id, batch.id, 5, { direction: "OUT", descriptionKey: "coffee", status: "SKIPPED" })
    const errored = await registry.makeImportRow(w.user.id, batch.id, 6, { direction: "OUT", descriptionKey: "coffee", status: "ERRORED", errorReason: "x" })
    const elsewhere = await registry.makeImportRow(w.user.id, otherBatch.id, 1, { direction: "OUT", descriptionKey: "coffee" })

    const count = await repo.updateRowsWhereSame(
      w.user.id,
      batch.id,
      { direction: "OUT", descriptionKey: "coffee", status: "PENDING" },
      { status: "READY", counterpartNodeId: w.food.id },
    )
    expect(count).toBe(2)
    const after = await repo.findRowsForBatch(w.user.id, batch.id)
    expect(after.filter((r) => r.status === "READY").map((r) => r.id).sort()).toEqual([hit1.id, hit2.id].sort())
    for (const untouched of [otherDirection, otherKey, skipped, errored]) {
      expect(await prisma.importRow.findUniqueOrThrow({ where: { id: untouched.id } })).toEqual(untouched)
    }
    expect(await prisma.importRow.findUniqueOrThrow({ where: { id: elsewhere.id } })).toEqual(elsewhere)
    // a repeat matches nothing now that they are READY
    expect(await repo.updateRowsWhereSame(w.user.id, batch.id, { direction: "OUT", descriptionKey: "coffee", status: "PENDING" }, { status: "READY", counterpartNodeId: w.food.id })).toBe(0)
  })

  it("does nothing to a batch that is not STAGED, and refuses a counterpart that is not the user's", async () => {
    const w = await registry.makeWorld()
    const uploaded = await registry.makeBatch(w.user.id, w.bank.id, { status: "UPLOADED" })
    await registry.makeImportRow(w.user.id, uploaded.id, 1, { direction: "OUT", descriptionKey: "coffee" })
    const match = { direction: "OUT", descriptionKey: "coffee", status: "PENDING" } as const
    expect(await repo.updateRowsWhereSame(w.user.id, uploaded.id, match, { status: "SKIPPED" })).toBe(0)
    const staged = await registry.makeBatch(w.user.id, w.bank.id)
    await registry.makeImportRow(w.user.id, staged.id, 1, { direction: "OUT", descriptionKey: "coffee" })
    await expectNotFound(repo.updateRowsWhereSame(w.user.id, staged.id, match, { counterpartNodeId: b.food.id }), "node")
  })
})

describe("markRowsCommitted", () => {
  it("marks READY rows COMMITTED with their transactions, all inside the caller's transaction", async () => {
    const w = await registry.makeWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const r1 = await registry.makeImportRow(w.user.id, batch.id, 1, { status: "READY", counterpartNodeId: w.food.id })
    const r2 = await registry.makeImportRow(w.user.id, batch.id, 2, { status: "READY", counterpartNodeId: w.food.id })
    const t1 = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id)
    const t2 = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id)
    await inTransaction((uow) =>
      repo.markRowsCommitted(w.user.id, [{ rowId: r1.id, transactionId: t1.id }, { rowId: r2.id, transactionId: t2.id }], uow),
    )
    expect(await prisma.importRow.findUniqueOrThrow({ where: { id: r1.id } })).toMatchObject({ status: "COMMITTED", transactionId: t1.id })
    expect(await prisma.importRow.findUniqueOrThrow({ where: { id: r2.id } })).toMatchObject({ status: "COMMITTED", transactionId: t2.id })
  })

  it("rolls back the lot when one row is not READY, and says import", async () => {
    const w = await registry.makeWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const ready = await registry.makeImportRow(w.user.id, batch.id, 1, { status: "READY", counterpartNodeId: w.food.id })
    const pending = await registry.makeImportRow(w.user.id, batch.id, 2)
    const t1 = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id)
    const t2 = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id)
    await expectNotFound(
      inTransaction((uow) =>
        repo.markRowsCommitted(w.user.id, [{ rowId: ready.id, transactionId: t1.id }, { rowId: pending.id, transactionId: t2.id }], uow),
      ),
      "import",
    )
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: ready.id } })).status).toBe("READY")
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("PENDING")
  })

  it("does nothing for no pairs", async () => {
    const w = await registry.makeWorld()
    await inTransaction((uow) => repo.markRowsCommitted(w.user.id, [], uow))
  })
})

describe("profiles", () => {
  it("upserts by name: a second save under the name replaces it", async () => {
    const w = await registry.makeWorld()
    const first = await repo.upsertProfile(w.user.id, { name: "HDFC", nodeId: w.bank.id, settings: { dateColumn: 0 } })
    expect(first).toMatchObject({ userId: w.user.id, name: "HDFC", nodeId: w.bank.id, settings: { dateColumn: 0 } })
    const second = await repo.upsertProfile(w.user.id, { name: "HDFC", nodeId: null, settings: { dateColumn: 2 } })
    expect(second.id).toBe(first.id)
    expect(second).toMatchObject({ nodeId: null, settings: { dateColumn: 2 } })
    const other = await repo.upsertProfile(w.user.id, { name: "ABC", nodeId: null, settings: [1, 2] })
    expect((await repo.findProfiles(w.user.id)).map((p) => p.name)).toEqual(["ABC", "HDFC"])
    expect(await repo.findProfileById(w.user.id, other.id)).toEqual(other)
    expect(await repo.findProfileById(w.user.id, "no-such-profile")).toBeNull()
  })

  it("lets two users use the same name, and refuses a ledger that is not the user's", async () => {
    const w = await registry.makeWorld()
    await repo.upsertProfile(w.user.id, { name: "shared name", nodeId: null, settings: {} })
    await repo.upsertProfile(b.user.id, { name: "shared name", nodeId: null, settings: {} })
    expect(await prisma.importProfile.count({ where: { name: "shared name", userId: { in: [w.user.id, b.user.id] } } })).toBe(2)
    await expectNotFound(repo.upsertProfile(w.user.id, { name: "x", nodeId: b.bank.id, settings: {} }), "node")
    expect(await prisma.importProfile.count({ where: { userId: w.user.id, name: "x" } })).toBe(0)
  })
})

describe("counterpart rules", () => {
  it("creates a rule at one hit, then moves it to the new ledger and counts the hit", async () => {
    const w = await registry.makeWorld()
    const rent = await registry.makeNode(w.user.id, "EXPENSE", "Rent")
    await inTransaction((uow) => repo.upsertRule(w.user.id, { direction: "OUT", descriptionKey: "coffee", nodeId: w.food.id }, uow))
    expect(await repo.findCounterpartRules(w.user.id)).toMatchObject([{ direction: "OUT", descriptionKey: "coffee", nodeId: w.food.id, hits: 1 }])
    await inTransaction((uow) => repo.upsertRule(w.user.id, { direction: "OUT", descriptionKey: "coffee", nodeId: rent.id }, uow))
    await inTransaction((uow) => repo.upsertRule(w.user.id, { direction: "IN", descriptionKey: "coffee", nodeId: w.income.id }, uow))
    const rules = await inTransaction((uow) => repo.findCounterpartRules(w.user.id, uow))
    expect(rules).toHaveLength(2)
    expect(rules.find((r) => r.direction === "OUT")).toMatchObject({ nodeId: rent.id, hits: 2 })
    expect(rules.find((r) => r.direction === "IN")).toMatchObject({ nodeId: w.income.id, hits: 1 })
  })

  it("refuses a ledger that is not the user's", async () => {
    const w = await registry.makeWorld()
    await expectNotFound(inTransaction((uow) => repo.upsertRule(w.user.id, { direction: "OUT", descriptionKey: "k", nodeId: b.food.id }, uow)), "node")
    expect(await repo.findCounterpartRules(w.user.id)).toEqual([])
  })
})

describe("countImportsNaming and deleteImportConfigFor", () => {
  it("counts batches of the account in any status plus rows choosing it as counterpart", async () => {
    const w = await registry.makeWorld()
    expect(await repo.countImportsNaming(w.user.id, w.bank.id)).toBe(0)
    const live = await registry.makeBatch(w.user.id, w.bank.id)
    await registry.makeBatch(w.user.id, w.bank.id, { status: "DISCARDED" })
    await registry.makeImportRow(w.user.id, live.id, 1, { status: "READY", counterpartNodeId: w.food.id })
    await registry.makeImportRow(w.user.id, live.id, 2, { counterpartNodeId: w.food.id })
    await registry.makeImportRow(w.user.id, live.id, 3)
    expect(await repo.countImportsNaming(w.user.id, w.bank.id)).toBe(2)
    expect(await repo.countImportsNaming(w.user.id, w.food.id)).toBe(2)
    expect(await inTransaction((uow) => repo.countImportsNaming(w.user.id, w.food.id, uow))).toBe(2)
    expect(await repo.countImportsNaming(w.user.id, w.income.id)).toBe(0)
  })

  it("deletes the user's profiles and rules naming the ledger and no others", async () => {
    const w = await registry.makeWorld()
    await repo.upsertProfile(w.user.id, { name: "for bank", nodeId: w.bank.id, settings: {} })
    await repo.upsertProfile(w.user.id, { name: "for food", nodeId: w.food.id, settings: {} })
    await repo.upsertProfile(w.user.id, { name: "for nothing", nodeId: null, settings: {} })
    await inTransaction(async (uow) => {
      await repo.upsertRule(w.user.id, { direction: "OUT", descriptionKey: "a", nodeId: w.food.id }, uow)
      await repo.upsertRule(w.user.id, { direction: "OUT", descriptionKey: "b", nodeId: w.bank.id }, uow)
    })
    await inTransaction((uow) => repo.deleteImportConfigFor(w.user.id, w.food.id, uow))
    expect((await repo.findProfiles(w.user.id)).map((p) => p.name)).toEqual(["for bank", "for nothing"])
    expect((await repo.findCounterpartRules(w.user.id)).map((r) => r.descriptionKey)).toEqual(["b"])
  })

  it("a profile used by a batch can be deleted: the batch keeps its history and loses the link", async () => {
    const w = await registry.makeWorld()
    const profile = await repo.upsertProfile(w.user.id, { name: "used", nodeId: w.food.id, settings: {} })
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { profileId: profile.id })
    await inTransaction((uow) => repo.deleteImportConfigFor(w.user.id, w.food.id, uow))
    expect((await repo.findBatchById(w.user.id, batch.id))?.profileId).toBeNull()
  })
})

describe("the calendar day of a staged row", () => {
  it("is stored and read as the plain day, whatever the time zone of the process", async () => {
    const w = await registry.makeWorld()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const day = calendarDate("2026-12-31")
    await inTransaction((uow) =>
      repo.insertRows(w.user.id, batch.id, [rowData(1, { occurredOn: new Date(`${day}T00:00:00.000Z`) })], uow),
    )
    const [row] = await repo.findRowsForBatch(w.user.id, batch.id)
    expect(row.occurredOn?.toISOString()).toBe("2026-12-31T00:00:00.000Z")
  })
})
