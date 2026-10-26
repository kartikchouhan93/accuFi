import { randomUUID } from "node:crypto"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { listPrices } from "@/server/repositories/price-repository"
import { recordTransaction } from "@/server/services/transaction-service"
import { createRegistry } from "./repositories/fixtures"

// Replace the session: what these tests care about is what each action does with the answer requireUserId gives
// (a user id, or UnauthenticatedError), not Auth.js itself.
const { requireUserId, UnauthenticatedError } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), UnauthenticatedError }
})
vi.mock("@/server/auth", () => ({ requireUserId, UnauthenticatedError }))
// revalidatePath needs a request to belong to; here it is replaced by a spy so a test can say which pages a write invalidates.
const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath }))

const actions = await import("@/app/investments/actions")

const registry = createRegistry()
afterAll(registry.cleanup)
beforeEach(() => {
  requireUserId.mockReset()
  revalidatePath.mockReset()
})

const UNIT = 1_000_000n
const g = (grams: bigint) => grams * UNIT

// Server Actions are the boundary: their return value is serialised to the browser, and JSON.stringify throws on bigint.
// A Date would not throw, it would turn into a string the screen did not expect, so the round trip must be lossless.
const expectPlain = (value: unknown) => {
  expect(() => JSON.stringify(value)).not.toThrow()
  expect(JSON.parse(JSON.stringify(value))).toEqual(value)
}

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

/**
 * A signed-in user with a bank holding Rs 2,00,000, the Realised Gain and Loss nodes, a contribution-only fund, and gold
 * valued by quantity (FIFO), 10g bought on 1 Jan 2026 for Rs 70,000 (Rs 7,000 a gram).
 */
async function signedInWorld() {
  const user = await registry.makeUser()
  requireUserId.mockResolvedValue(user.id)
  const income = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  await registry.makeNode(user.id, "INCOME_SOURCE", "Realised Gain", { systemRole: "REALISED_GAIN" })
  await registry.makeNode(user.id, "EXPENSE", "Realised Loss", { systemRole: "REALISED_LOSS" })
  const fund = await registry.makeNode(user.id, "INVESTMENT", "Index SIP", { valuationMode: "CONTRIBUTION_ONLY" })
  const gold = await registry.makeNode(user.id, "INVESTMENT", "Gold", { valuationMode: "QUANTITY", unitLabel: "g", lotMethod: "FIFO" })
  await registry.makeTransaction(user.id, income.id, bank.id, { amountPaise: 2_00_000_00n, occurredAt: "2025-12-01" })
  await recordTransaction(user.id, {
    fromNodeId: bank.id,
    toNodeId: gold.id,
    amount: 70_000_00n,
    quantity: g(10n),
    occurredAt: calendarDate("2026-01-01"),
    idempotencyKey: randomUUID(),
  })
  const sale = (over: Record<string, unknown> = {}) => ({
    nodeId: gold.id,
    toNodeId: bank.id,
    quantity: "4",
    proceeds: "30,000",
    occurredAt: "2026-03-01",
    ...over,
  })
  const sell = (over: Record<string, unknown> = {}) => ({ ...sale(over), idempotencyKey: randomUUID(), ...over })
  return { user, income, bank, food, fund, gold, sale, sell }
}

type Failure = { ok: false; error: { code: string; message: string; fieldErrors?: Record<string, string[]> } }
const failure = (result: { ok: boolean }): Failure => {
  if (result.ok) throw new Error("expected a failure")
  return result as Failure
}

describe("every Server Action", () => {
  it("sends the user to /login, before reading its input, when the session is gone", async () => {
    const exported = Object.entries(actions)
    expect(exported.map(([name]) => name).sort()).toEqual([
      "deletePriceAction",
      "getHoldingAction",
      "previewPriceAction",
      "previewSaleAction",
      "recordPriceAction",
      "sellAction",
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

  it("rejects input that is not an object, and an unknown key (a forged userId included), as invalid input", async () => {
    const { user, gold, bank, sale, sell } = await signedInWorld()
    const price = { nodeId: gold.id, asOf: "2026-03-01", price: "7,800" }
    const calls: [string, (input: unknown) => Promise<{ ok: boolean }>, unknown][] = [
      ["getHolding", actions.getHoldingAction, { nodeId: gold.id }],
      ["previewSale", actions.previewSaleAction, sale()],
      ["sell", actions.sellAction, sell()],
      ["previewPrice", actions.previewPriceAction, price],
      ["recordPrice", actions.recordPriceAction, price],
      ["deletePrice", actions.deletePriceAction, { nodeId: gold.id, asOf: "2026-03-01" }],
    ]
    for (const [name, action, valid] of calls) {
      expect(await action("not-an-object"), name).toMatchObject({ ok: false, error: { code: "invalid_input" } })
      expect(await action({ ...(valid as object), userId: bank.id }), name).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    }
    // A sale's key belongs to the write only: asking for a preview with one is a mistake worth saying so.
    expect(await actions.previewSaleAction(sell())).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    expect(await prisma.lotConsumption.count({ where: { userId: user.id } })).toBe(0)
  })
})

describe("getHoldingAction", () => {
  it("returns the holding with its lots and prices as plain data", async () => {
    const { user, gold } = await signedInWorld()
    await actions.recordPriceAction({ nodeId: gold.id, asOf: "2026-02-01", price: "7,800" })
    const result = await actions.getHoldingAction({ nodeId: gold.id })
    expect(result).toMatchObject({
      ok: true,
      data: {
        nodeId: gold.id,
        quantityHeld: "10",
        costBasisPaise: "7000000",
        valuePaise: "7800000",
        unrealisedGainPaise: "800000",
        lots: [{ acquiredAt: "2026-01-01", quantity: "10", quantityRemaining: "10", costBasisPaise: "7000000" }],
        prices: [{ asOf: "2026-02-01", pricePerUnitPaise: "780000" }],
      },
    })
    expectPlain(result)
    expect(await listPrices(user.id, gold.id)).toHaveLength(1)
  })

  it("reads a contribution-only investment, and answers not-found for an account or another user's node", async () => {
    const mine = await signedInWorld()
    expect(await actions.getHoldingAction({ nodeId: mine.fund.id })).toMatchObject({ ok: true, data: { lots: [], prices: [], notValued: null } })
    expect(await actions.getHoldingAction({ nodeId: mine.bank.id })).toMatchObject({ ok: false, error: { code: "not_found" } })
    await signedInWorld() // a different user is now signed in; the id below is the first user's
    const result = await actions.getHoldingAction({ nodeId: mine.gold.id })
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } })
    expectPlain(result)
  })

  it("does not invalidate any page", async () => {
    const { gold } = await signedInWorld()
    await actions.getHoldingAction({ nodeId: gold.id })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe("previewSaleAction", () => {
  it("returns the figures a sale would post, in paise text and units, and writes nothing", async () => {
    const { user, sale } = await signedInWorld()
    const before = await prisma.transaction.count({ where: { userId: user.id } })
    const result = await actions.previewSaleAction(sale())
    expect(result).toEqual({
      ok: true,
      data: {
        costBasisPaise: "2800000",
        proceedsPaise: "3000000",
        gainPaise: "200000",
        allocations: [{ acquiredAt: "2026-01-01", quantity: "4", costBasisPaise: "2800000" }],
      },
    })
    expectPlain(result)
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(before)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("states a loss as a negative paise string", async () => {
    const { sale } = await signedInWorld()
    const result = await actions.previewSaleAction(sale({ proceeds: "20,000" }))
    expect(result).toMatchObject({ ok: true, data: { costBasisPaise: "2800000", gainPaise: "-800000" } })
    expectPlain(result)
  })

  it("answers more than is held as insufficient_quantity on the quantity field, in the investment's units", async () => {
    const { sale } = await signedInWorld()
    const result = await actions.previewSaleAction(sale({ quantity: "11" }))
    const { error } = failure(result)
    expect(error.code).toBe("insufficient_quantity")
    expect(error.message).toContain("Only 10 g of Gold is available to sell")
    expect(error.fieldErrors).toEqual({ quantity: [error.message] })
    expectPlain(result)
  })

  it("files each refusal under the control that fixes it", async () => {
    const { user, bank, food, fund, sale } = await signedInWorld()
    const fieldsOf = async (over: Record<string, unknown>) => {
      const result = failure(await actions.previewSaleAction(sale(over)))
      expect(result.error.code).toBe("invalid")
      expectPlain(result)
      return Object.keys(result.error.fieldErrors ?? {})
    }
    // The investment: the money must come from one that is sold by lot, and one that is not archived.
    expect(await fieldsOf({ nodeId: fund.id })).toEqual(["nodeId"]) // NOT_SOLD_BY_LOT
    expect(await fieldsOf({ nodeId: bank.id, toNodeId: food.id })).toEqual(["nodeId", "toNodeId"])
    const oldGold = await registry.makeNode(user.id, "INVESTMENT", "Old gold", { valuationMode: "QUANTITY", unitLabel: "g", archivedAt: new Date() })
    expect(await fieldsOf({ nodeId: oldGold.id })).toEqual(["nodeId"]) // ARCHIVED_SOURCE
    // The destination: not an account (SALE_DESTINATION), or archived (ARCHIVED_TARGET).
    expect(await fieldsOf({ toNodeId: food.id })).toEqual(["toNodeId"])
    const oldBank = await registry.makeNode(user.id, "ASSET", "Old bank", { archivedAt: new Date() })
    expect(await fieldsOf({ toNodeId: oldBank.id })).toEqual(["toNodeId"])
  })

  it("files a lump sold other than whole, and a quantity too small to carry a cost, under the quantity", async () => {
    const { user, bank, sale } = await signedInWorld()
    const flat = await registry.makeNode(user.id, "INVESTMENT", "Flat", { valuationMode: "LUMP", unitLabel: "flat" })
    await recordTransaction(user.id, {
      fromNodeId: bank.id,
      toNodeId: flat.id,
      amount: 5_00_000_00n,
      quantity: g(1n),
      occurredAt: calendarDate("2026-01-02"),
      idempotencyKey: randomUUID(),
    })
    const lump = failure(await actions.previewSaleAction(sale({ nodeId: flat.id, quantity: "2" })))
    expect(lump.error).toMatchObject({ code: "invalid", fieldErrors: { quantity: [expect.stringContaining("sold whole")] } })

    // 3 units for one paisa: a millionth of a unit costs a third of a millionth of a paisa, which rounds to nothing.
    const dust = await registry.makeNode(user.id, "INVESTMENT", "Dust", { valuationMode: "QUANTITY", unitLabel: "u" })
    await recordTransaction(user.id, {
      fromNodeId: bank.id,
      toNodeId: dust.id,
      amount: 1n,
      quantity: g(3n),
      occurredAt: calendarDate("2026-01-02"),
      idempotencyKey: randomUUID(),
    })
    const small = failure(await actions.previewSaleAction(sale({ nodeId: dust.id, quantity: "0.000001" })))
    expect(small.error).toMatchObject({ code: "invalid", fieldErrors: { quantity: [expect.stringContaining("less than half a paisa")] } })
  })

  it("answers not-found for another user's investment or destination", async () => {
    const mine = await signedInWorld()
    const theirs = await signedInWorld() // the session is now the second user
    expect(await actions.previewSaleAction({ ...theirs.sale(), nodeId: mine.gold.id })).toMatchObject({ ok: false, error: { code: "not_found" } })
    expect(await actions.previewSaleAction({ ...theirs.sale(), toNodeId: mine.bank.id })).toMatchObject({ ok: false, error: { code: "not_found" } })
  })

  it("returns field errors for malformed text", async () => {
    const { sale } = await signedInWorld()
    const result = failure(await actions.previewSaleAction(sale({ quantity: "1.2345678", proceeds: "0", occurredAt: "2026-02-30" })))
    expect(result.error.code).toBe("invalid_input")
    expect(Object.keys(result.error.fieldErrors ?? {}).sort()).toEqual(["occurredAt", "proceeds", "quantity"])
  })
})

describe("sellAction", () => {
  it("sells, returning the legs and the figures posted as plain data", async () => {
    const { user, bank, gold, sell } = await signedInWorld()
    const result = await actions.sellAction(sell({ note: "partial exit" }))
    expect(result).toMatchObject({
      ok: true,
      data: {
        legs: [
          { fromNodeId: gold.id, toNodeId: bank.id, amountPaise: "2800000", occurredAt: "2026-03-01", note: "partial exit" },
          { toNodeId: bank.id, amountPaise: "200000" },
        ],
        preview: { costBasisPaise: "2800000", proceedsPaise: "3000000", gainPaise: "200000" },
      },
    })
    expectPlain(result)
    expect(await prisma.lotConsumption.count({ where: { userId: user.id } })).toBe(1)
    expect(await actions.getHoldingAction({ nodeId: gold.id })).toMatchObject({ ok: true, data: { quantityHeld: "6", costBasisPaise: "4200000" } })
  })

  it("answers a replayed key with the first result, writing nothing more", async () => {
    const { user, sell } = await signedInWorld()
    const body = sell()
    const first = await actions.sellAction(body)
    const second = await actions.sellAction(body)
    expect(first.ok && second.ok && second.data.legs.map((l) => l.id)).toEqual(first.ok && first.data.legs.map((l) => l.id))
    expect(await prisma.lotConsumption.count({ where: { userId: user.id } })).toBe(1)
  })

  it("answers a different request on a used key as request_conflict", async () => {
    const { sell } = await signedInWorld()
    const body = sell()
    expect((await actions.sellAction(body)).ok).toBe(true)
    const result = await actions.sellAction({ ...body, quantity: "5" })
    expect(result).toMatchObject({ ok: false, error: { code: "request_conflict" } })
    expect(failure(result).error.message).toContain("already sent once")
    expectPlain(result)
  })

  it("answers more than is held as insufficient_quantity on the quantity field, writing nothing", async () => {
    const { user, sell } = await signedInWorld()
    const result = failure(await actions.sellAction(sell({ quantity: "10.000001" })))
    expect(result.error.code).toBe("insufficient_quantity")
    expect(result.error.fieldErrors).toEqual({ quantity: [result.error.message] })
    expect(result.error.message).toContain("Only 10 g of Gold")
    expectPlain(result)
    expect(await prisma.lotConsumption.count({ where: { userId: user.id } })).toBe(0)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("answers a rule the sale breaks as invalid, on the field that fixes it, writing nothing", async () => {
    const { user, food, fund, sell } = await signedInWorld()
    const before = await prisma.transaction.count({ where: { userId: user.id } })
    expect(await actions.sellAction(sell({ toNodeId: food.id }))).toMatchObject({
      ok: false,
      error: { code: "invalid", fieldErrors: { toNodeId: [expect.any(String)] } },
    })
    expect(await actions.sellAction(sell({ nodeId: fund.id }))).toMatchObject({
      ok: false,
      error: { code: "invalid", fieldErrors: { nodeId: [expect.any(String)] } },
    })
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(before)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("returns field errors for invalid input, an empty key included, and writes nothing", async () => {
    const { user, sell } = await signedInWorld()
    const before = await prisma.transaction.count({ where: { userId: user.id } })
    const result = failure(await actions.sellAction(sell({ proceeds: "0", occurredAt: "2026-02-30", idempotencyKey: "" })))
    expect(result.error.code).toBe("invalid_input")
    expect(Object.keys(result.error.fieldErrors ?? {}).sort()).toEqual(["idempotencyKey", "occurredAt", "proceeds"])
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(before)
  })

  it("answers not-found for another user's investment, and writes nothing for them", async () => {
    const mine = await signedInWorld()
    const theirs = await signedInWorld()
    const result = await actions.sellAction({ ...theirs.sell(), nodeId: mine.gold.id })
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } })
    expectPlain(result)
    expect(await prisma.lotConsumption.count({ where: { userId: { in: [mine.user.id, theirs.user.id] } } })).toBe(0)
  })
})

describe("previewPriceAction", () => {
  const price = (nodeId: string, over: Record<string, unknown> = {}) => ({ nodeId, asOf: "2026-03-01", price: "7,800", ...over })

  it("shows today's value before and after the proposed price, as paise text, and writes nothing", async () => {
    const { user, gold } = await signedInWorld()
    const first = await actions.previewPriceAction(price(gold.id))
    expect(first).toEqual({ ok: true, data: { beforePaise: null, afterPaise: "7800000", changePaise: null } })
    expect(await listPrices(user.id, gold.id)).toHaveLength(0)

    await actions.recordPriceAction(price(gold.id))
    const rise = await actions.previewPriceAction(price(gold.id, { asOf: "2026-04-01", price: "8,000" }))
    expect(rise).toEqual({ ok: true, data: { beforePaise: "7800000", afterPaise: "8000000", changePaise: "200000" } })
    const fall = await actions.previewPriceAction(price(gold.id, { asOf: "2026-04-01", price: "7,000" }))
    expect(fall).toEqual({ ok: true, data: { beforePaise: "7800000", afterPaise: "7000000", changePaise: "-800000" } })
    expectPlain(fall)
    expect(await listPrices(user.id, gold.id)).toHaveLength(1)
  })

  it("says null, not zero, for a value an investment cannot have until its entries carry a quantity", async () => {
    const { user, bank } = await signedInWorld()
    const nifty = await registry.makeNode(user.id, "INVESTMENT", "Nifty", { valuationMode: "QUANTITY", unitLabel: "units" })
    await registry.makeTransaction(user.id, bank.id, nifty.id, { amountPaise: 10_000_00n, occurredAt: "2026-01-05" }) // no quantity, no lot
    const result = await actions.previewPriceAction(price(nifty.id, { price: "100" }))
    expect(result).toEqual({ ok: true, data: { beforePaise: null, afterPaise: null, changePaise: null } })
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  it("files each refusal under its own field: the investment, the day, the price", async () => {
    const { fund, gold, bank } = await signedInWorld()
    const notRevalued = failure(await actions.previewPriceAction(price(fund.id)))
    expect(notRevalued.error).toMatchObject({ code: "invalid", fieldErrors: { nodeId: [expect.stringContaining("not revalued")] } })
    expect(Object.keys(notRevalued.error.fieldErrors ?? {})).toEqual(["nodeId"])
    const account = failure(await actions.previewPriceAction(price(bank.id)))
    expect(Object.keys(account.error.fieldErrors ?? {})).toEqual(["nodeId"])
    const future = failure(await actions.previewPriceAction(price(gold.id, { asOf: "2999-01-01" })))
    expect(future.error).toMatchObject({ code: "invalid", fieldErrors: { asOf: ["A price cannot be dated after today."] } })
    expect(Object.keys(future.error.fieldErrors ?? {})).toEqual(["asOf"])
    const zero = failure(await actions.previewPriceAction(price(gold.id, { price: "0" })))
    expect(zero.error.code).toBe("invalid_input")
    expect(Object.keys(zero.error.fieldErrors ?? {})).toEqual(["price"])
    expectPlain(future)
  })

  it("answers not-found for another user's investment", async () => {
    const mine = await signedInWorld()
    await signedInWorld()
    expect(await actions.previewPriceAction(price(mine.gold.id))).toMatchObject({ ok: false, error: { code: "not_found" } })
  })
})

describe("recordPriceAction and deletePriceAction", () => {
  const price = (nodeId: string, over: Record<string, unknown> = {}) => ({ nodeId, asOf: "2026-03-01", price: "7,800", ...over })

  it("records a price, replaces the one of the same day, and deletes it", async () => {
    const { user, gold } = await signedInWorld()
    expect(await actions.recordPriceAction(price(gold.id))).toEqual({ ok: true, data: null })
    expect(await listPrices(user.id, gold.id)).toEqual([{ asOf: "2026-03-01", pricePerUnitPaise: 780_000n }])
    expect(await actions.recordPriceAction(price(gold.id, { price: "7,900.50" }))).toEqual({ ok: true, data: null })
    expect(await listPrices(user.id, gold.id)).toEqual([{ asOf: "2026-03-01", pricePerUnitPaise: 790_050n }])
    expect(await actions.deletePriceAction({ nodeId: gold.id, asOf: "2026-03-01" })).toEqual({ ok: true, data: null })
    expect(await listPrices(user.id, gold.id)).toEqual([])
  })

  it("refuses what the preview refuses, with the same field, and writes nothing", async () => {
    const { user, fund, gold } = await signedInWorld()
    expect(failure(await actions.recordPriceAction(price(fund.id))).error.fieldErrors).toHaveProperty("nodeId")
    expect(failure(await actions.recordPriceAction(price(gold.id, { asOf: "2999-01-01" }))).error.fieldErrors).toHaveProperty("asOf")
    expect(await prisma.priceSnapshot.count({ where: { userId: user.id } })).toBe(0)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("answers not-found for deleting a day with no price, and for another user's investment", async () => {
    const mine = await signedInWorld()
    await actions.recordPriceAction(price(mine.gold.id))
    expect(await actions.deletePriceAction({ nodeId: mine.gold.id, asOf: "2026-03-02" })).toMatchObject({ ok: false, error: { code: "not_found" } })
    const theirs = await signedInWorld()
    expect(await actions.recordPriceAction(price(mine.gold.id))).toMatchObject({ ok: false, error: { code: "not_found" } })
    expect(await actions.deletePriceAction({ nodeId: mine.gold.id, asOf: "2026-03-01" })).toMatchObject({ ok: false, error: { code: "not_found" } })
    expect(await listPrices(mine.user.id, mine.gold.id)).toHaveLength(1)
    expect(await listPrices(theirs.user.id, mine.gold.id)).toHaveLength(0)
  })
})

describe("cache invalidation", () => {
  const revalidated = () => revalidatePath.mock.calls.map(([path]) => path).sort()
  const everywhere = ["/", "/investments", "/investments/prices", "/nodes", "/transactions"]

  it("invalidates every screen that shows money or prices after each write that succeeds", async () => {
    const { gold, sell } = await signedInWorld()
    const writes: [string, () => Promise<unknown>][] = [
      ["sell", () => actions.sellAction(sell())],
      ["recordPrice", () => actions.recordPriceAction({ nodeId: gold.id, asOf: "2026-03-01", price: "7,800" })],
      ["deletePrice", () => actions.deletePriceAction({ nodeId: gold.id, asOf: "2026-03-01" })],
    ]
    for (const [name, write] of writes) {
      revalidatePath.mockReset()
      expect(await write(), name).toMatchObject({ ok: true })
      expect(revalidated(), name).toEqual(everywhere)
    }
  })

  it("invalidates nothing for a read", async () => {
    const { gold, sale } = await signedInWorld()
    await actions.getHoldingAction({ nodeId: gold.id })
    await actions.previewSaleAction(sale())
    await actions.previewPriceAction({ nodeId: gold.id, asOf: "2026-03-01", price: "7,800" })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
