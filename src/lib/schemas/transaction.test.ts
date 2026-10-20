import { describe, expect, it } from "vitest"
import {
  editTransactionSchema,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  recordTransactionSchema,
  transactionIdSchema,
} from "./transaction"

const valid = {
  fromNodeId: "from",
  toNodeId: "to",
  amount: "1,234.50",
  occurredAt: "2026-04-01",
  idempotencyKey: "0123456789abcdef",
}
const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.path.join("."))

describe("recordTransactionSchema", () => {
  it("turns rupee text into paise and the date text into a CalendarDate, trimming the note and tags", () => {
    const result = recordTransactionSchema.safeParse({ ...valid, note: "  lunch ", tags: [" a ", "b"] })
    expect(result.success && result.data).toEqual({
      fromNodeId: "from",
      toNodeId: "to",
      amount: 123_450n,
      occurredAt: "2026-04-01",
      note: "lunch",
      tags: ["a", "b"],
      idempotencyKey: "0123456789abcdef",
    })
  })

  it("rejects an empty idempotency key, and one too short to be unique", () => {
    // The repository treats "" as no key at all while the insert stores it, so a repeat would leak a Prisma error.
    expect(issuePaths(recordTransactionSchema.safeParse({ ...valid, idempotencyKey: "" }))).toEqual(["idempotencyKey"])
    expect(
      issuePaths(recordTransactionSchema.safeParse({ ...valid, idempotencyKey: "x".repeat(IDEMPOTENCY_KEY_MIN_LENGTH - 1) })),
    ).toEqual(["idempotencyKey"])
    expect(recordTransactionSchema.safeParse({ ...valid, idempotencyKey: "x".repeat(IDEMPOTENCY_KEY_MIN_LENGTH) }).success).toBe(true)
  })

  it("requires an idempotency key", () => {
    const { idempotencyKey: _omitted, ...without } = valid
    void _omitted
    expect(issuePaths(recordTransactionSchema.safeParse(without))).toEqual(["idempotencyKey"])
  })

  it.each([["0"], ["0.00"], ["-5"], ["12.345"], ["abc"], [""], ["1e3"]])("rejects the amount %j", (amount) => {
    expect(issuePaths(recordTransactionSchema.safeParse({ ...valid, amount }))).toEqual(["amount"])
  })

  it("never accepts money as a number", () => {
    expect(recordTransactionSchema.safeParse({ ...valid, amount: 12.5 }).success).toBe(false)
  })

  it.each([["2026-02-30"], ["2026-13-01"], ["01/04/2026"], ["2026-04-01T00:00:00Z"], [""]])("rejects the date %j", (occurredAt) => {
    expect(issuePaths(recordTransactionSchema.safeParse({ ...valid, occurredAt }))).toEqual(["occurredAt"])
  })

  it("is strict: a forged userId, groupId or version is an error, not silently dropped", () => {
    for (const extra of [{ userId: "x" }, { groupId: "g" }, { version: 3 }, { deletedAt: "2026-01-01" }]) {
      expect(recordTransactionSchema.safeParse({ ...valid, ...extra }).success, JSON.stringify(extra)).toBe(false)
    }
  })

  it("limits the note and the tags", () => {
    expect(issuePaths(recordTransactionSchema.safeParse({ ...valid, note: "x".repeat(501) }))).toEqual(["note"])
    expect(recordTransactionSchema.safeParse({ ...valid, tags: [""] }).success).toBe(false)
    expect(recordTransactionSchema.safeParse({ ...valid, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).success).toBe(false)
  })
})

describe("editTransactionSchema", () => {
  const edit = { id: "t1", expectedVersion: 2, changes: { amount: "10" } }

  it("parses the changes it is given and leaves the rest absent", () => {
    const result = editTransactionSchema.safeParse({
      ...edit,
      changes: { amount: "10", occurredAt: "2026-04-02", note: null, tags: [] },
    })
    expect(result.success && result.data).toEqual({
      id: "t1",
      expectedVersion: 2,
      changes: { amount: 1_000n, occurredAt: "2026-04-02", note: null, tags: [] },
    })
  })

  it("requires the version the user was looking at", () => {
    expect(issuePaths(editTransactionSchema.safeParse({ id: "t1", changes: { amount: "10" } }))).toEqual(["expectedVersion"])
    expect(editTransactionSchema.safeParse({ ...edit, expectedVersion: -1 }).success).toBe(false)
    expect(editTransactionSchema.safeParse({ ...edit, expectedVersion: 1.5 }).success).toBe(false)
    expect(editTransactionSchema.safeParse({ ...edit, expectedVersion: "2" }).success).toBe(false)
  })

  it("rejects an edit that changes nothing", () => {
    expect(editTransactionSchema.safeParse({ ...edit, changes: {} }).success).toBe(false)
  })

  it("applies the field rules of a new entry to each change, and refuses keys that are not editable", () => {
    expect(issuePaths(editTransactionSchema.safeParse({ ...edit, changes: { amount: "0" } }))).toEqual(["changes.amount"])
    expect(issuePaths(editTransactionSchema.safeParse({ ...edit, changes: { occurredAt: "nope" } }))).toEqual(["changes.occurredAt"])
    expect(editTransactionSchema.safeParse({ ...edit, changes: { amount: "10", userId: "x" } }).success).toBe(false)
    expect(editTransactionSchema.safeParse({ ...edit, changes: { amount: "10", idempotencyKey: "0123456789abcdef" } }).success).toBe(false)
  })
})

describe("transactionIdSchema", () => {
  it("takes exactly an id", () => {
    expect(transactionIdSchema.safeParse({ id: "t1" }).success).toBe(true)
    expect(transactionIdSchema.safeParse({ id: "" }).success).toBe(false)
    expect(transactionIdSchema.safeParse({ id: "t1", userId: "x" }).success).toBe(false)
  })
})
