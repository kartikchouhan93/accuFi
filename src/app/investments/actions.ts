"use server"

import type { z } from "zod"
import { InsufficientQuantityError } from "@/domain/lots"
import { formatQuantity } from "@/domain/quantity"
import type { HoldingDetail, RevaluationPreviewView, SalePreviewView } from "@/lib/investment-view"
import { priceDaySchema, priceSchema, previewSaleSchema, sellSchema } from "@/lib/schemas/investment"
import { nodeIdSchema } from "@/lib/schemas/node"
import { serialisePaise } from "@/lib/serialise"
import type { TransactionView } from "@/lib/transaction-view"
import { failed, fieldErrorsOf, ok, redirectIfUnauthenticated, wrote, type ActionFailure, type ActionResult } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { NotFoundError } from "@/server/repositories/errors"
import { loadHolding, previewSale, sellInvestment, type SalePreview } from "@/server/services/investment-service"
import { deletePrice, InvalidPriceError, previewRevaluation, recordPrice, type PriceRuleCode, type RevaluationPreview } from "@/server/services/price-service"
import { InvalidTransactionError, RequestKeyConflictError, type TransactionViolation, type TransactionViolationCode } from "@/server/services/transaction-service"

// Server Actions for investments: the holding, selling (or redeeming) part of one, and entering prices. Shaped like the
// transaction and node actions: each asks requireUserId() who is calling before it reads its input, parses the input
// with Zod (`unknown`, because a Server Action is a public endpoint; every schema is strict, so a forged `userId` is an
// error), then calls the service. Results are plain data: money as a paise string, quantities as decimal text in units,
// days as "YYYY-MM-DD", a value that does not exist as null (never "0"). A bigint or a Date in a result is a runtime
// crash when Next serialises it, so nothing but views leaves here, on the failure paths too.
//
// Expected refusals come back as `{ ok: false }` so a form can show them; an unexpected error is rethrown for Next to
// log (and mask in production). A missing session redirects to /login.
//
// A write ends with `wrote()` (action-support.ts), which also renews /investments and /investments/prices. Reads
// (`getHoldingAction` and the two previews) do not.

function parseInput<S extends z.ZodType>(schema: S, input: unknown): { data: z.output<S> } | ActionFailure {
  const parsed = schema.safeParse(input)
  if (parsed.success) return { data: parsed.data }
  return failed("invalid_input", "Check the highlighted fields", fieldErrorsOf(parsed.error))
}

// The form field a broken rule belongs to, for a sale. The Sell form has the investment it sells from (`nodeId`, which
// the screen already knows, so it may show these beside the figures rather than beside a control), the destination
// account (`toNodeId`), the quantity, the proceeds and the day (`occurredAt`).
//
//   the investment      NOT_SOLD_BY_LOT (no lots to sell: a contribution-only investment, or not an investment)
//                       ARCHIVED_SOURCE
//   the destination     SALE_DESTINATION (not an account, or a card or loan it pays towards), ARCHIVED_TARGET
//   the quantity        QUANTITY_OUT_OF_RANGE, LUMP_QUANTITY (a lump is sold whole), QUANTITY_TOO_SMALL (the cost
//                       rounds to nothing), and InsufficientQuantityError, which has its own code
//   the proceeds        NON_POSITIVE_AMOUNT (the sale's one amount is called proceeds here, not amount)
//
// The rest are the transaction rules the legs are checked against, which the checks above already cover (a refusal
// from them is a bug, not something a user can fix); each is filed where the transaction form would, and they are here
// because the record is total over the codes. A sale's day is never refused by a rule of its own: a day before the
// units were bought leaves too little to sell, which is InsufficientQuantityError, says so in its message and goes on
// `quantity`.
const SALE_FIELD_OF_VIOLATION: Record<TransactionViolationCode, string> = {
  NOT_SOLD_BY_LOT: "nodeId",
  ARCHIVED_SOURCE: "nodeId",
  SALE_DESTINATION: "toNodeId",
  ARCHIVED_TARGET: "toNodeId",
  QUANTITY_OUT_OF_RANGE: "quantity",
  LUMP_QUANTITY: "quantity",
  QUANTITY_TOO_SMALL: "quantity",
  NON_POSITIVE_AMOUNT: "proceeds",
  SAME_NODE: "toNodeId",
  ILLEGAL_FLOW: "toNodeId",
  QUANTITY_REQUIRED: "quantity",
  QUANTITY_NOT_APPLICABLE: "quantity",
  LUMP_ALREADY_BOUGHT: "toNodeId",
  QUANTITY_BELOW_SOLD: "quantity",
  AMOUNT_BELOW_SOLD: "proceeds",
  SOLD_COST_CHANGED: "proceeds",
  DATE_AFTER_SALE: "occurredAt",
  LOT_SOURCE: "nodeId",
  LOT_SWITCH: "toNodeId",
  LOT_SPLIT_LEG: "toNodeId",
  LOT_SOLD: "toNodeId",
}

// The form field a broken price rule belongs to: the investment, the day, the price. By the code the service gives, so
// each message sits beside the control that fixes it.
const FIELD_OF_PRICE_RULE: Record<PriceRuleCode, string> = {
  NOT_REVALUED: "nodeId",
  PRICE_AFTER_TODAY: "asOf",
  PRICE_NOT_POSITIVE: "price",
}

function violationFieldErrors(violations: readonly TransactionViolation[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const violation of violations) (out[SALE_FIELD_OF_VIOLATION[violation.code]] ??= []).push(violation.message)
  return out
}

function toFailure(error: unknown): ActionFailure {
  redirectIfUnauthenticated(error) // throws a redirect, so nothing below runs for a lapsed session
  // Before InvalidTransactionError, which it extends. A sale has no split to take a leg out of, so this is a form sent
  // twice with a change in between, or a key reused by another request.
  if (error instanceof RequestKeyConflictError) {
    return failed(
      "request_conflict",
      "This form was already sent once, and what you are sending now is different. The first sale may have been recorded, so check the investment's lots. If it is not there, clear the form and enter it again.",
    )
  }
  if (error instanceof InvalidTransactionError) {
    const fieldErrors = violationFieldErrors(error.violations)
    return failed("invalid", error.message, Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined)
  }
  // The service states what is available, in the investment's unit (EC-21). It is about the quantity the user typed.
  if (error instanceof InsufficientQuantityError) return failed("insufficient_quantity", error.message, { quantity: [error.message] })
  if (error instanceof InvalidPriceError) return failed("invalid", error.message, { [FIELD_OF_PRICE_RULE[error.code]]: [error.message] })
  if (error instanceof NotFoundError) return failed("not_found", "That investment, account or price was not found")
  throw error
}

function toSalePreviewView(preview: SalePreview): SalePreviewView {
  return {
    costBasisPaise: serialisePaise(preview.costBasisPaise),
    proceedsPaise: serialisePaise(preview.proceedsPaise),
    gainPaise: serialisePaise(preview.gainPaise),
    allocations: preview.allocations.map((a) => ({
      acquiredAt: a.acquiredAt,
      quantity: formatQuantity(a.quantity),
      costBasisPaise: serialisePaise(a.costBasisPaise),
    })),
  }
}

const orNull = (paise: bigint | null): string | null => (paise === null ? null : serialisePaise(paise))

function toRevaluationPreviewView(preview: RevaluationPreview): RevaluationPreviewView {
  return { beforePaise: orNull(preview.beforePaise), afterPaise: orNull(preview.afterPaise), changePaise: orNull(preview.changePaise) }
}

/** One investment as of today: its holding and value, its lots with what each still holds, and every price it has. */
export async function getHoldingAction(input: unknown): Promise<ActionResult<HoldingDetail>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(nodeIdSchema, input)
    if ("ok" in parsed) return parsed
    return ok(await loadHolding(userId, parsed.data.nodeId))
  } catch (error) {
    return toFailure(error)
  }
}

/** The figures a sale would post, while the form is being filled in. Writes nothing; refuses what `sellAction` refuses. */
export async function previewSaleAction(input: unknown): Promise<ActionResult<SalePreviewView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(previewSaleSchema, input)
    if ("ok" in parsed) return parsed
    return ok(toSalePreviewView(await previewSale(userId, parsed.data)))
  } catch (error) {
    return toFailure(error)
  }
}

/** Sell (or redeem) part of an investment: the legs the sale posted, the cost-basis leg first, and the figures. */
export async function sellAction(input: unknown): Promise<ActionResult<{ legs: TransactionView[]; preview: SalePreviewView }>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(sellSchema, input)
    if ("ok" in parsed) return parsed
    const { legs, preview } = await sellInvestment(userId, parsed.data)
    wrote()
    return ok({ legs, preview: toSalePreviewView(preview) })
  } catch (error) {
    return toFailure(error)
  }
}

/** What the investment would be worth today with this price saved, beside what it is worth now. Writes nothing. */
export async function previewPriceAction(input: unknown): Promise<ActionResult<RevaluationPreviewView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(priceSchema, input)
    if ("ok" in parsed) return parsed
    const { nodeId, asOf, price } = parsed.data
    return ok(toRevaluationPreviewView(await previewRevaluation(userId, { nodeId, asOf, pricePerUnit: price })))
  } catch (error) {
    return toFailure(error)
  }
}

/** Enter the price of one unit on a day; a day that already has a price is replaced (EC-26). */
export async function recordPriceAction(input: unknown): Promise<ActionResult<null>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(priceSchema, input)
    if ("ok" in parsed) return parsed
    const { nodeId, asOf, price } = parsed.data
    await recordPrice(userId, { nodeId, asOf, pricePerUnit: price })
    wrote()
    return ok(null)
  } catch (error) {
    return toFailure(error)
  }
}

/** Delete the investment's price for one day. */
export async function deletePriceAction(input: unknown): Promise<ActionResult<null>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(priceDaySchema, input)
    if ("ok" in parsed) return parsed
    await deletePrice(userId, parsed.data.nodeId, parsed.data.asOf)
    wrote()
    return ok(null)
  } catch (error) {
    return toFailure(error)
  }
}
