import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/server/db"
import { IMPORT_MAX_BYTES } from "@/server/services/import-service"
import { createRegistry } from "../repositories/fixtures"

// POST /api/import/upload (src/app/api/import/upload/route.ts), against the real database. The session is replaced
// the same way the Server Action tests replace it; revalidatePath is a spy. The route is called directly as a
// function (`POST(request)`), the same way Next.js's runtime calls a route handler.

const { requireUserId, UnauthenticatedError } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), UnauthenticatedError }
})
vi.mock("@/server/auth", () => ({ requireUserId, UnauthenticatedError }))
const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath }))

const { POST } = await import("@/app/api/import/upload/route")

const registry = createRegistry()
afterAll(registry.cleanup)
beforeEach(() => {
  requireUserId.mockReset()
  revalidatePath.mockReset()
})

async function signedInWorld() {
  const user = await registry.makeUser()
  requireUserId.mockResolvedValue(user.id)
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  return { user, bank }
}

const bytesOf = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text))

function formDataRequest(fields: { nodeId?: string; file?: Blob | null; fileName?: string; profileId?: string }, headers?: Record<string, string>) {
  const form = new FormData()
  if (fields.nodeId !== undefined) form.set("nodeId", fields.nodeId)
  if (fields.file !== undefined && fields.file !== null) form.set("file", fields.file, fields.fileName ?? "statement.csv")
  if (fields.profileId !== undefined) form.set("profileId", fields.profileId)
  return new Request("http://localhost/api/import/upload", { method: "POST", body: form, headers })
}

async function json(response: Response): Promise<unknown> {
  return response.json()
}

describe("POST /api/import/upload", () => {
  it("accepts a valid file and answers the new batch's id", async () => {
    const w = await signedInWorld()
    const text = "Date,Description,Amount\n01/04/2026,Coffee,120.00"
    const request = formDataRequest({ nodeId: w.bank.id, file: new Blob([bytesOf(text)], { type: "text/csv" }) })
    const response = await POST(request)
    expect(response.status).toBe(200)
    const body = (await json(response)) as { ok: true; data: { batchId: string } }
    expect(body.ok).toBe(true)
    expect(typeof body.data.batchId).toBe("string")
    const stored = await prisma.importBatch.findUniqueOrThrow({ where: { id: body.data.batchId } })
    expect(stored.nodeId).toBe(w.bank.id)
    expect(stored.fileName).toBe("statement.csv")
    expect(stored.status).toBe("UPLOADED")
    expect(revalidatePath).toHaveBeenCalledWith("/import")
  })

  it("uploads an identical earlier file again without refusing it (the repeat warning is the map screen's job)", async () => {
    const w = await signedInWorld()
    const text = "Date,Description,Amount\n01/04/2026,Coffee,120.00"
    const first = await POST(formDataRequest({ nodeId: w.bank.id, file: new Blob([bytesOf(text)]) }))
    const second = await POST(formDataRequest({ nodeId: w.bank.id, file: new Blob([bytesOf(text)]) }))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstBody = (await json(first)) as { data: { batchId: string } }
    const secondBody = (await json(second)) as { data: { batchId: string } }
    expect(firstBody.data.batchId).not.toBe(secondBody.data.batchId)
  })

  it("answers 401 JSON, never a redirect, with no session, and never reads the body", async () => {
    requireUserId.mockImplementation(async () => {
      throw new UnauthenticatedError()
    })
    const request = formDataRequest({ nodeId: "x", file: new Blob(["irrelevant"]) })
    const response = await POST(request)
    expect(response.status).toBe(401)
    const body = (await json(response)) as { ok: false; error: { code: string; message: string } }
    expect(body).toEqual({ ok: false, error: { code: "unauthenticated", message: "Sign in to upload a statement." } })
  })

  it("rejects a declared content-length over the cap with 413, before reading the body or the session", async () => {
    const request = formDataRequest(
      { nodeId: "x", file: new Blob(["irrelevant"]) },
      { "content-length": String(IMPORT_MAX_BYTES + 65_536 + 1) },
    )
    const response = await POST(request)
    expect(response.status).toBe(413)
    const body = (await json(response)) as { ok: false; error: { code: string; message: string } }
    expect(body).toEqual({ ok: false, error: { code: "invalid", message: "That file is larger than 5 MB." } })
    expect(requireUserId).not.toHaveBeenCalled()
  })

  it("accepts a declared length right at the cap plus slack", async () => {
    const w = await signedInWorld()
    const request = formDataRequest(
      { nodeId: w.bank.id, file: new Blob([bytesOf("Date,Description,Amount\n01/04/2026,Coffee,120.00")]) },
      { "content-length": String(IMPORT_MAX_BYTES + 65_536) },
    )
    const response = await POST(request)
    expect(response.status).toBe(200)
  })

  it("rejects an oversize real file with 413, once the declared length passed", async () => {
    const w = await signedInWorld()
    const big = new Uint8Array(IMPORT_MAX_BYTES + 1000).fill(97)
    const request = formDataRequest({ nodeId: w.bank.id, file: new Blob([big]) })
    const response = await POST(request)
    expect(response.status).toBe(413)
    const body = (await json(response)) as { ok: false; error: { code: string; message: string } }
    expect(body).toEqual({ ok: false, error: { code: "invalid", message: "That file is larger than 5 MB." } })
    expect(await prisma.importBatch.count({ where: { userId: w.user.id } })).toBe(0)
  })

  it("answers an empty file with 400 and the exact message", async () => {
    const w = await signedInWorld()
    const request = formDataRequest({ nodeId: w.bank.id, file: new Blob([]) })
    const response = await POST(request)
    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({ ok: false, error: { code: "invalid", message: "That file is empty." } })
  })

  it("answers a file with a NUL byte as 400, never echoing its content", async () => {
    const w = await signedInWorld()
    const MARKER = "SECRET_MARKER_q7f3"
    const request = formDataRequest({ nodeId: w.bank.id, file: new Blob([bytesOf(`${MARKER}\0 rest of the file`)]) })
    const response = await POST(request)
    expect(response.status).toBe(400)
    const text = JSON.stringify(await json(response))
    expect(text).not.toContain(MARKER)
    expect(text).toContain("That does not look like a text file.")
  })

  it("answers a missing file field with 400 and an exact message", async () => {
    const w = await signedInWorld()
    const request = formDataRequest({ nodeId: w.bank.id })
    const response = await POST(request)
    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({
      ok: false,
      error: { code: "invalid_input", message: "Choose a file to upload.", fieldErrors: { file: ["Choose a file to upload."] } },
    })
  })

  it("refuses an investment account with 400", async () => {
    const w = await signedInWorld()
    const gold = await registry.makeNode(w.user.id, "INVESTMENT", "Gold")
    const request = formDataRequest({ nodeId: gold.id, file: new Blob([bytesOf("Date,Description,Amount\n01/04/2026,Coffee,120.00")]) })
    const response = await POST(request)
    expect(response.status).toBe(400)
    const body = (await json(response)) as { ok: false; error: { code: string } }
    expect(body.error.code).toBe("invalid")
  })

  it("refuses a foreign account with 404 and the exact message", async () => {
    await signedInWorld()
    const stranger = await registry.makeUser()
    const theirs = await registry.makeNode(stranger.id, "ASSET", "Theirs")
    const request = formDataRequest({ nodeId: theirs.id, file: new Blob([bytesOf("Date,Description,Amount\n01/04/2026,Coffee,120.00")]) })
    const response = await POST(request)
    expect(response.status).toBe(404)
    expect(await json(response)).toEqual({ ok: false, error: { code: "not_found", message: "That ledger was not found" } })
  })

  it("never echoes the uploaded file's content in a successful response", async () => {
    const w = await signedInWorld()
    const MARKER = "SECRET_MARKER_q7f3"
    const request = formDataRequest({ nodeId: w.bank.id, file: new Blob([bytesOf(`Date,Description,Amount\n01/04/2026,${MARKER},120.00`)]) })
    const response = await POST(request)
    const text = JSON.stringify(await json(response))
    expect(text).not.toContain(MARKER)
  })
})
