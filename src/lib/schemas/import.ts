import { z } from "zod"
import { IMPORT_DELIMITERS, IMPORT_ENCODINGS } from "../../domain/import-csv"
import { IMPORT_DATE_FORMATS } from "../../domain/import-map"

// What a client may send to stage a batch or save a mapping. Strict like the other schemas: an unknown key is an
// error, not silently dropped. No server imports, relative domain imports as in transaction.ts, so a client form can
// reuse `importMappingSchema`. The column indexes are zero-based and refer to a row of cells after `skipRows`; "not
// chosen yet" (the map screen's own sentinel, -1) is never valid here, only a real column is.

const nonNegativeColumn = z.number().int().min(0, "Choose a column")

const AMOUNT_COLUMNS_MESSAGE = "Choose an amount column, or both a debit and a credit column, not both"

const columnsSchema = z
  .strictObject({
    date: nonNegativeColumn,
    description: nonNegativeColumn,
    amount: nonNegativeColumn.optional(),
    debit: nonNegativeColumn.optional(),
    credit: nonNegativeColumn.optional(),
  })
  .superRefine((value, ctx) => {
    const hasAmount = value.amount !== undefined
    const hasDebit = value.debit !== undefined
    const hasCredit = value.credit !== undefined
    const validAmountOnly = hasAmount && !hasDebit && !hasCredit
    const validSplit = !hasAmount && hasDebit && hasCredit
    if (!validAmountOnly && !validSplit) {
      ctx.addIssue({ code: "custom", message: AMOUNT_COLUMNS_MESSAGE, path: ["amount"] })
    }
  })

export const SKIP_ROWS_MAX = 50

export const importMappingSchema = z.strictObject({
  delimiter: z.enum(IMPORT_DELIMITERS),
  encoding: z.enum(IMPORT_ENCODINGS),
  skipRows: z.number().int().min(0).max(SKIP_ROWS_MAX, `At most ${SKIP_ROWS_MAX} rows to skip`),
  dateFormat: z.enum(IMPORT_DATE_FORMATS),
  decimalSeparator: z.enum([".", ","]),
  signConvention: z.enum(["POSITIVE_OUT", "POSITIVE_IN"]),
  columns: columnsSchema,
})

export const PROFILE_NAME_MAX_LENGTH = 60

export const stageBatchSchema = z.strictObject({
  id: z.string().min(1),
  mapping: importMappingSchema,
  confirmedRepeat: z.boolean(),
})

export const saveProfileSchema = z.strictObject({
  name: z.string().trim().min(1, "Enter a name").max(PROFILE_NAME_MAX_LENGTH, `At most ${PROFILE_NAME_MAX_LENGTH} characters`),
  nodeId: z.string().min(1).optional(),
  mapping: importMappingSchema,
})

export const batchIdSchema = z.strictObject({ id: z.string().min(1) })
