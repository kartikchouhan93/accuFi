import { z } from "zod"
import { positiveRupees, rupees } from "./rupees"
import { idempotencyKeyField, nodeIdField, noteField, occurredAtField, quantityField } from "./transaction"

// What a client may send to sell (or redeem) part of an investment, and to preview that sale before submitting it.
// Strict like the transaction schemas. Rupee text becomes paise, quantity text becomes micro-units (exactly or not at
// all, EC-27) and day text becomes a CalendarDate here, as validation issues, with the same field rules as a transaction
// (transaction.ts). Whether the investment can be sold, and whether the destination can take the money, only the
// service knows. No server imports, so the Sell form can reuse it; relative imports as in the other schema files.

const saleFields = {
  /** The investment sold from. */
  nodeId: nodeIdField,
  /** The account the proceeds go into. */
  toNodeId: nodeIdField,
  quantity: quantityField,
  /** What the sale brought in, in all. */
  proceeds: positiveRupees,
  occurredAt: occurredAtField,
}

/** A sale as the Sell / redeem form submits it: one request key per submission, as for a transaction. */
export const sellSchema = z.strictObject({ ...saleFields, note: noteField.optional(), idempotencyKey: idempotencyKeyField })

/** The figures a sale would post, asked for while the form is being filled in: nothing is written, so there is no key. */
export const previewSaleSchema = z.strictObject(saleFields)

// What a client may send to enter, preview or delete a price: one investment, one day, and for entering or previewing the
// price of one unit in rupees (of the whole asset for a lump). Strict like the rest. Whether the investment is revalued
// and whether the day is allowed, only the service knows (price-service.ts). The price field is named for the form's
// control; `rupees` would accept zero, so the refusal is stated here in the price's own words.
const price = rupees.refine((paise) => paise > 0n, "Enter a price greater than zero")

const priceDay = { nodeId: nodeIdField, asOf: occurredAtField }

export const priceSchema = z.strictObject({ ...priceDay, price })
export const priceDaySchema = z.strictObject(priceDay)
