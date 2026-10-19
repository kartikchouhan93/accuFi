import { redirect } from "next/navigation"
import type { ZodError } from "zod"
import { UnauthenticatedError } from "@/server/auth"

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

export interface ActionFailure {
  ok: false
  error: { code: ActionErrorCode; message: string; fieldErrors?: Record<string, string[]> }
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
 */
export function redirectIfUnauthenticated(error: unknown): void {
  if (error instanceof UnauthenticatedError) redirect("/login")
}

/** Zod issues as `{ fieldName: [messages] }`; an issue about the input as a whole is filed under "form". */
export function fieldErrorsOf(error: ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "form"
    ;(out[key] ??= []).push(issue.message)
  }
  return out
}
