import { failed, redirectIfUnauthenticated, type ActionFailure } from "@/server/action-support"
import { NotFoundError } from "@/server/repositories/errors"
import {
  ImportFileError,
  ImportNotReadyError,
  ImportRepeatUnconfirmedError,
  ImportRowsIllegalError,
  InvalidImportError,
} from "@/server/services/import-service"

// What an expected refusal of the import actions and the upload route looks like to the screen. Anything else is
// rethrown for Next to log. The statement's own bytes never reach a message here: every string below is fixed, or
// built only from a line number and a reason that is itself never derived from the file's content.

/** `InvalidImportError`'s violations as `{ field: [messages] }`, the shape the form files them under. */
function importFieldErrors(error: InvalidImportError): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const violation of error.violations) (out[violation.field] ??= []).push(violation.message)
  return out
}

/** A fixed message per `ImportFileError` code, independent of the error's own `.message`: never built from the file. */
const FILE_ERROR_MESSAGES: Record<ImportFileError["code"], string> = {
  EMPTY: "That file is empty.",
  TOO_LARGE: "That file is larger than 5 MB.",
  NOT_TEXT: "That does not look like a text file.",
  TOO_MANY_ROWS: "That file has more than 20,000 rows.",
}

/** The first five lines of `ImportRowsIllegalError`, named by line, with how many more there are when there are more. */
function illegalRowsMessage(error: ImportRowsIllegalError): string {
  const shown = error.rows.slice(0, 5).map((row) => `Line ${row.line}: ${row.reason}`)
  const extra = error.rows.length - shown.length
  return extra > 0 ? `${shown.join("; ")}; and ${extra} more` : shown.join("; ")
}

/**
 * Maps a thrown import-service error to what the screen shows, or null for anything it does not recognise (the
 * caller rethrows that). Pure: it never redirects, so the upload route (which answers a lapsed session with 401 JSON,
 * never a redirect) and `toImportFailure` (which does redirect) can both build on it without duplicating messages.
 */
export function mapImportFailure(error: unknown): ActionFailure | null {
  if (error instanceof InvalidImportError) return failed("invalid", error.message, importFieldErrors(error))
  if (error instanceof ImportFileError) return failed("invalid", FILE_ERROR_MESSAGES[error.code])
  if (error instanceof ImportRepeatUnconfirmedError) {
    return failed("invalid", "You uploaded this exact file before. Confirm to continue.")
  }
  if (error instanceof ImportNotReadyError) return failed("invalid", `${error.pending} row(s) still need a decision.`)
  if (error instanceof ImportRowsIllegalError) return failed("invalid", illegalRowsMessage(error))
  if (error instanceof NotFoundError) {
    return failed(
      "not_found",
      error.entity === "node" ? "That ledger was not found" : "This import no longer exists. It may have been discarded in another tab.",
    )
  }
  return null
}

/** The HTTP status the upload route answers with for a mapped failure's code. */
export function statusForImportFailure(code: ActionFailure["error"]["code"]): number {
  return code === "not_found" ? 404 : 400
}

export function toImportFailure(error: unknown): ActionFailure {
  redirectIfUnauthenticated(error) // throws a redirect, so nothing below runs for a lapsed session
  const mapped = mapImportFailure(error)
  if (mapped) return mapped
  throw error
}
