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

  it("treats a 200 non-JSON answer (JSON-typed garbage included) as an expired session, never throwing", async () => {
    const garbage = new Response("{not json", { status: 200, headers: { "content-type": "application/json" } })
    const htmlAtTwoHundred = new Response("<html>anything</html>", { status: 200, headers: { "content-type": "text/html" } })
    const wrongShape = json({ hello: "world" })
    for (const response of [garbage, htmlAtTwoHundred, wrongShape]) {
      await expect(readUploadResponse(response)).resolves.toEqual({ kind: "expired" })
    }
  })

  it("names a non-200, non-JSON answer by its status rather than calling it a lapsed session (ruling R9)", async () => {
    // A real login-page landing is always a followed redirect's final 200; a reverse proxy rejecting the request
    // itself - most concretely a 413 from a body-size limit smaller than this app's own 5 MB cap - carries its own
    // status instead.
    const tooLarge = new Response("<html>413 Request Entity Too Large</html>", { status: 413, headers: { "content-type": "text/html" } })
    expect(await readUploadResponse(tooLarge)).toEqual({ kind: "blocked", status: 413 })

    const badGateway = new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } })
    expect(await readUploadResponse(badGateway)).toEqual({ kind: "blocked", status: 502 })

    const empty = new Response(null, { status: 500 })
    expect(await readUploadResponse(empty)).toEqual({ kind: "blocked", status: 500 })
  })

  it("says exactly what the ruling words", () => {
    expect(SESSION_EXPIRED_MESSAGE).toBe("Your session has expired. Sign in again and retry.")
  })
})
