import { describe, expect, it } from "vitest"
import { readUploadResponse, SESSION_EXPIRED_MESSAGE } from "./upload-response"

// Ruling R2 (final review I13): the upload form treats anything that is not the upload route's own JSON as an expired
// session, never as success and never as an uncaught parse failure.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } })

describe("readUploadResponse", () => {
  it("reads a successful upload's batch id", async () => {
    expect(await readUploadResponse(json({ ok: true, data: { batchId: "b1" } }))).toEqual({ kind: "uploaded", batchId: "b1" })
  })

  it("reads the route's own refusal, field errors included", async () => {
    const outcome = await readUploadResponse(
      json({ ok: false, error: { code: "invalid_input", message: "Check the fields", fieldErrors: { nodeId: ["Choose an account"] } } }, 400),
    )
    expect(outcome).toEqual({
      kind: "failed",
      failure: { code: "invalid_input", message: "Check the fields", fieldErrors: { nodeId: ["Choose an account"] } },
    })
    expect(await readUploadResponse(json({ ok: false, error: { code: "unauthenticated", message: "Sign in" } }, 401))).toEqual({
      kind: "failed",
      failure: { code: "unauthenticated", message: "Sign in" },
    })
  })

  it("treats the login page's HTML after a lapsed session's redirect (a 200) as an expired session, not a success", async () => {
    const loginPage = new Response("<!doctype html><html><body><form>Sign in</form></body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })
    expect(await readUploadResponse(loginPage)).toEqual({ kind: "expired" })
  })

  it("treats any other non-JSON answer (an HTML error page, an empty body, JSON-typed garbage) as an expired session, never throwing", async () => {
    const htmlError = new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })
    const empty = new Response(null, { status: 500 })
    const garbage = new Response("{not json", { status: 200, headers: { "content-type": "application/json" } })
    const wrongShape = json({ hello: "world" })
    for (const response of [htmlError, empty, garbage, wrongShape]) {
      await expect(readUploadResponse(response)).resolves.toEqual({ kind: "expired" })
    }
  })

  it("says exactly what the ruling words", () => {
    expect(SESSION_EXPIRED_MESSAGE).toBe("Your session has expired. Sign in again and retry.")
  })
})
