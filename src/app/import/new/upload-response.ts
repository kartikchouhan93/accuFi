// What the upload form makes of the upload route's answer (ruling R2, docs/superpowers/decisions/2026-11-02-m6-rulings.md).
// The route only ever answers JSON: `{ ok: true, data: { batchId } }`, or `{ ok: false, error }` with a 4xx status. Anything
// else — above all the login page's own HTML, which is what a lapsed session gets back once the proxy redirects the
// request to /login (a 200, after the redirect is followed), or any other HTML error page — is never read as success and
// never as a generic failure: it is "your session has expired", which is what it almost always means and the one thing
// the person can act on. No browser API here beyond the standard `Response`, so the rule is testable on its own.

export const SESSION_EXPIRED_MESSAGE = "Your session has expired. Sign in again and retry."

export interface UploadFailure {
  code: string
  message: string
  fieldErrors?: Record<string, string[]>
}

export type UploadOutcome = { kind: "uploaded"; batchId: string } | { kind: "failed"; failure: UploadFailure } | { kind: "expired" }

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

/** Read the upload route's answer: the new batch's id, the route's own refusal, or (for anything that is not the route's
 * JSON) an expired session. Never throws. */
export async function readUploadResponse(response: Response): Promise<UploadOutcome> {
  const body = await jsonBody(response)
  if (!isRecord(body)) return { kind: "expired" }
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
  // JSON, but not the route's shape: not something this form can trust as an upload either way.
  return { kind: "expired" }
}
