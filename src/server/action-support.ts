import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import type { z } from "zod"
import { fieldErrorsOf } from "@/lib/field-errors"
import type { TransactionView } from "@/lib/transaction-view"
import { auth, UnauthenticatedError } from "@/server/auth"
import { UserNotFoundError } from "@/server/repositories/errors"
import { findUserTimezone } from "@/server/repositories/user-repository"
import type { TransactionViolation, TransactionViolationCode } from "@/server/services/transaction-errors"

// Shared by every Server Action file. It cannot live in one: a "use server" module may export only async functions.

/** Every refusal an action can answer with, so a UI can switch on it exhaustively. */
export type ActionErrorCode =
  | "invalid_input"
  | "system_node"
  | "has_history"
  | "hierarchy_depth"
  | "invalid"
  | "not_found"
  | "kind_immutable"
  | "version_conflict"
  | "overdraft_blocked"
  | "request_conflict"
  | "insufficient_quantity"

export interface ActionFailure {
  ok: false
  error: {
    code: ActionErrorCode
    message: string
    fieldErrors?: Record<string, string[]>
    /** With "version_conflict": what is stored now, as plain data, for the screen to show beside the user's edit. */
    current?: TransactionView
  }
}

/** A Server Action's answer. Plain data only: it is serialised to the browser, so no bigint and no Date. */
export type ActionResult<T> = { ok: true; data: T } | ActionFailure

export const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data })

export const failed = (code: ActionErrorCode, message: string, fieldErrors?: Record<string, string[]>): ActionFailure => ({
  ok: false,
  error: fieldErrors ? { code, message, fieldErrors } : { code, message },
})

/**
 * An expired or missing session sends the user to /login instead of surfacing a generic error. requireUserId() throws
 * UnauthenticatedError in that case; an action calls this first in its catch block and everything else carries on.
 * `redirect` throws, so this never returns for an UnauthenticatedError. The route guard (src/proxy.ts) already
 * redirects page navigations without a session; this covers an action that arrives after the session has lapsed.
 *
 * A session can also be validly signed for a user whose row is gone (a JWT cannot be revoked, so it outlives its user
 * by up to its lifetime). The services answer that with UserNotFoundError, and it takes the same road: the session is
 * dead, so the person is sent to sign in, and no default is substituted for what the missing row would have said.
 * Every page and action already calls this, so a new read of the user row needs nothing else. (The stale cookie is
 * left to expire or be replaced at the next sign-in: a Server Component cannot clear it.)
 */
export function redirectIfUnauthenticated(error: unknown): void {
  if (error instanceof UnauthenticatedError || error instanceof UserNotFoundError) redirect("/login")
}

/**
 * Whether the request carries a session for a user who still exists. The sign-in and sign-up pages send such a
 * person on to "/"; with only the cookie to go by, a ghost session would be sent to "/", back to /login, and so on.
 */
export async function hasLiveSession(): Promise<boolean> {
  const userId = (await auth())?.user?.id
  return typeof userId === "string" && userId.length > 0 && (await findUserTimezone(userId)) !== null
}

/**
 * Called by a write, after it has committed, so no screen that shows money is served stale: the transaction list, the
 * ledger with its balances, the investments with their values, and the home page with net worth. One list for every
 * action file, because a write in one place moves figures in the others (an account created with an opening balance changes net worth on "/" and the
 * balances on "/transactions"), and `router.refresh()` renews only the page the user happens to be on. The investment
 * screens are listed too: a sale moves the holdings and a price moves their values, and both move net worth. Reads and
 * refused writes do not call it.
 */
export function wrote(): void {
  revalidatePath("/transactions")
  revalidatePath("/nodes")
  revalidatePath("/investments")
  revalidatePath("/investments/prices")
  revalidatePath("/recurring")
  revalidatePath("/")
}

/** Parse an action's `unknown` input: the data, or the `invalid_input` failure carrying the field errors. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): { data: z.output<S> } | ActionFailure {
  const parsed = schema.safeParse(input)
  if (parsed.success) return { data: parsed.data }
  return failed("invalid_input", "Check the highlighted fields", fieldErrorsOf(parsed.error))
}

// The form field a broken transaction rule belongs to (shared by the transaction and recurring actions, which both
// surface the transaction rules). A rule about the pair of nodes or the flow is filed under the destination:
// that is the control a user changes to fix it (the source is what they chose first), and the message names both. An
// archived end is filed under its own control. The source is shared by every leg of a split, so its field has no leg.
// The lot rules go under the field they are about: the quantity, the amount, the day, or the source that money cannot
// leave this way; a switch, a split leg, a second purchase of a lump or a sold purchase being moved is fixed by choosing
// another destination.
const FIELD_OF_VIOLATION: Record<TransactionViolationCode, string> = {
  SAME_NODE: "toNodeId",
  ILLEGAL_FLOW: "toNodeId",
  ARCHIVED_SOURCE: "fromNodeId",
  ARCHIVED_TARGET: "toNodeId",
  NON_POSITIVE_AMOUNT: "amount",
  QUANTITY_REQUIRED: "quantity",
  QUANTITY_NOT_APPLICABLE: "quantity",
  QUANTITY_OUT_OF_RANGE: "quantity",
  LUMP_QUANTITY: "quantity",
  LUMP_ALREADY_BOUGHT: "toNodeId",
  QUANTITY_BELOW_SOLD: "quantity",
  AMOUNT_BELOW_SOLD: "amount",
  SOLD_COST_CHANGED: "amount",
  DATE_AFTER_SALE: "occurredAt",
  LOT_SOURCE: "fromNodeId",
  LOT_SWITCH: "toNodeId",
  LOT_SPLIT_LEG: "toNodeId",
  LOT_SOLD: "toNodeId",
  // Only a sale (investment-service.ts) breaks these; they are here because the record is total over the codes.
  NOT_SOLD_BY_LOT: "fromNodeId",
  SALE_DESTINATION: "toNodeId",
  QUANTITY_TOO_SMALL: "quantity",
}

/** Violations as `{ field: [messages] }`, a split's under `legs.<index>.<field>` so a form can find the leg's row. */
export function violationFieldErrors(violations: readonly TransactionViolation[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const violation of violations) {
    const field = FIELD_OF_VIOLATION[violation.code]
    const key = violation.leg === undefined || field === "fromNodeId" ? field : `legs.${violation.leg}.${field}`
    ;(out[key] ??= []).push(violation.message)
  }
  return out
}

// Lives in src/lib so a service can use it without importing the session; every action file still gets it from here.
export { fieldErrorsOf }
