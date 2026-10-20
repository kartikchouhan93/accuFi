import { describe, expect, it } from "vitest"
import {
  editTransactionSchema,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  recordSplitSchema,
  recordTransactionSchema,
  SPLIT_LEGS_MAX,
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

  it("words a missing key and a too-short key differently", () => {
    const message = (idempotencyKey: string) => {
      const result = recordTransactionSchema.safeParse({ ...valid, idempotencyKey })
      return result.success ? "" : result.error.issues[0].message
    }
    expect(message("")).toBe("A request key is required")
    expect(message("short-key")).toBe(`A request key must be at least ${IDEMPOTENCY_KEY_MIN_LENGTH} characters`)
    expect(message("short-key")).not.toMatch(/required/)
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

describe("recordSplitSchema", () => {
  const split = {
    fromNodeId: "from",
    occurredAt: "2026-04-01",
    legs: [
      { toNodeId: "a", amount: "2,000" },
      { toNodeId: "b", amount: "1,000.50", note: " shirt " },
    ],
    idempotencyKey: "0123456789abcdef",
  }

  it("turns each leg's rupee text into paise and trims its note", () => {
    const result = recordSplitSchema.safeParse({ ...split, total: "3,000.50", tags: [" trip "] })
    expect(result.success && result.data).toEqual({
      fromNodeId: "from",
      occurredAt: "2026-04-01",
      legs: [
        { toNodeId: "a", amount: 200_000n },
        { toNodeId: "b", amount: 100_050n, note: "shirt" },
      ],
      total: 300_050n,
      tags: ["trip"],
      idempotencyKey: "0123456789abcdef",
    })
  })

  it("needs two to fifty legs", () => {
    expect(issuePaths(recordSplitSchema.safeParse({ ...split, legs: split.legs.slice(0, 1) }))).toEqual(["legs"])
    expect(issuePaths(recordSplitSchema.safeParse({ ...split, legs: [] }))).toEqual(["legs"])
    const many = Array.from({ length: SPLIT_LEGS_MAX + 1 }, () => split.legs[0])
    expect(issuePaths(recordSplitSchema.safeParse({ ...split, legs: many }))).toEqual(["legs"])
  })

  it("applies the amount rules to each leg and names the leg that breaks them", () => {
    const bad = { ...split, legs: [split.legs[0], { toNodeId: "b", amount: "0" }, { toNodeId: "c", amount: "1.234" }] }
    expect(issuePaths(recordSplitSchema.safeParse(bad))).toEqual(["legs.1.amount", "legs.2.amount"])
    expect(issuePaths(recordSplitSchema.safeParse({ ...split, total: "0" }))).toEqual(["total"])
  })

  it("holds the one request key to the same length floor as a single transaction", () => {
    expect(issuePaths(recordSplitSchema.safeParse({ ...split, idempotencyKey: "" }))).toEqual(["idempotencyKey"])
    expect(
      issuePaths(recordSplitSchema.safeParse({ ...split, idempotencyKey: "x".repeat(IDEMPOTENCY_KEY_MIN_LENGTH - 1) })),
    ).toEqual(["idempotencyKey"])
    expect(recordSplitSchema.safeParse({ ...split, idempotencyKey: "x".repeat(IDEMPOTENCY_KEY_MIN_LENGTH) }).success).toBe(true)
  })

  it("is strict: a forged groupId or a leg that names its own source is an error", () => {
    expect(recordSplitSchema.safeParse({ ...split, groupId: "g" }).success).toBe(false)
    expect(recordSplitSchema.safeParse({ ...split, legs: [{ ...split.legs[0], userId: "u" }, split.legs[1]] }).success).toBe(false)
    expect(recordSplitSchema.safeParse({ ...split, legs: [{ ...split.legs[0], fromNodeId: "x" }, split.legs[1]] }).success).toBe(false)
  })
})
