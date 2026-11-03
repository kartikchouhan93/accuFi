// What the upload form makes of the upload route's answer (ruling R2, docs/superpowers/decisions/2026-11-02-m6-rulings.md).
// The route only ever answers JSON: `{ ok: true, data: { batchId } }`, or `{ ok: false, error }` with a 4xx status. A
// non-JSON body that still carries a 200 — the login page's own HTML, which is what a lapsed session gets back once the
// browser follows the proxy's redirect to /login — is read as "your session has expired", which is what it almost always
// means and the one thing the person can act on. A non-JSON body with any OTHER status is read differently (ruling R9):
// a real login-page landing is always a followed redirect's final 200, so a non-200, non-JSON answer is a reverse proxy
// rejecting the request itself — most commonly a 413 from a body-size limit smaller than this app's own 5 MB cap — and
// is named by its status rather than misreported as a lapsed session. No browser API here beyond the standard
// `Response`, so the rule is testable on its own.

export const SESSION_EXPIRED_MESSAGE = "Your session has expired. Sign in again and retry."

export interface UploadFailure {
  code: string
  message: string
  fieldErrors?: Record<string, string[]>
}

export type UploadOutcome =
  | { kind: "uploaded"; batchId: string }
  | { kind: "failed"; failure: UploadFailure }
  | { kind: "expired" }
  | { kind: "blocked"; status: number }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** The body as JSON, or null when it is not JSON at all (wrong content type, or a body that does not parse). */
async function jsonBody(response: Response): Promise<unknown | null> {
  const type = response.headers.get("content-type") ?? ""
  if (!type.toLowerCase().includes("application/json")) return null
  try {
    return await response.json()
  } catch {
    return null
  }
}

/** Read the upload route's answer: the new batch's id, the route's own refusal, an expired session, or (R9) a proxy's
 * own rejection, named by its status. Never throws. */
export async function readUploadResponse(response: Response): Promise<UploadOutcome> {
  const body = await jsonBody(response)
  if (!isRecord(body)) return response.status === 200 ? { kind: "expired" } : { kind: "blocked", status: response.status }
  if (response.ok && body.ok === true && isRecord(body.data) && typeof body.data.batchId === "string") {
    return { kind: "uploaded", batchId: body.data.batchId }
  }
  if (!response.ok && body.ok === false && isRecord(body.error) && typeof body.error.message === "string") {
    const error = body.error
    return {
      kind: "failed",
      failure: {
        code: typeof error.code === "string" ? error.code : "invalid",
        message: error.message as string,
        ...(isRecord(error.fieldErrors) ? { fieldErrors: error.fieldErrors as Record<string, string[]> } : {}),
      },
    }
  }
  // JSON, but not the route's shape: no proxy error page reads as JSON, so this is still the lapsed-session case,
  // regardless of status.
  return { kind: "expired" }
}
