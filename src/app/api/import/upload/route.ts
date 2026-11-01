import { revalidatePath } from "next/cache"
import { NextResponse } from "next/server"
import { mapImportFailure, statusForImportFailure } from "@/app/import/import-failure"
import { requireUserId, UnauthenticatedError } from "@/server/auth"
import { UserNotFoundError } from "@/server/repositories/errors"
import { createBatch, IMPORT_MAX_BYTES } from "@/server/services/import-service"

export const dynamic = "force-dynamic"

// The one route handler in the import feature: a multipart file cannot travel through a Server Action in this app's
// pattern, so the upload itself lands here, and everything else about an import (stage, decide, commit, reverse) is a
// Server Action (src/app/import/actions.ts). A missing session answers 401 JSON here, never a redirect: unlike a page
// or an action, a fetch from the upload form has nowhere to be redirected to. The statement's bytes are read once,
// handed straight to createBatch, and never echoed back in any response.

/** Slack over `IMPORT_MAX_BYTES` for multipart overhead (the boundary, field headers, the other fields) before the
 * declared length is refused outright, without reading a single byte of the body. */
const DECLARED_LENGTH_SLACK = 65_536

const SIZE_REFUSAL = { ok: false as const, error: { code: "invalid" as const, message: "That file is larger than 5 MB." } }

function jsonFailure(code: "invalid_input" | "unauthenticated", message: string, status: number, fieldErrors?: Record<string, string[]>) {
  return NextResponse.json({ ok: false, error: fieldErrors ? { code, message, fieldErrors } : { code, message } }, { status })
}

export async function POST(request: Request): Promise<Response> {
  const declaredLength = request.headers.get("content-length")
  if (declaredLength !== null && Number(declaredLength) > IMPORT_MAX_BYTES + DECLARED_LENGTH_SLACK) {
    return NextResponse.json(SIZE_REFUSAL, { status: 413 })
  }

  let userId: string
  try {
    userId = await requireUserId()
  } catch (error) {
    if (error instanceof UnauthenticatedError || error instanceof UserNotFoundError) {
      return jsonFailure("unauthenticated", "Sign in to upload a statement.", 401)
    }
    throw error
  }

  const form = await request.formData()
  const nodeId = form.get("nodeId")
  const file = form.get("file")
  const profileIdRaw = form.get("profileId")

  if (typeof nodeId !== "string" || nodeId.length === 0) {
    return jsonFailure("invalid_input", "Choose an account.", 400, { nodeId: ["Choose an account."] })
  }
  if (!(file instanceof Blob)) {
    return jsonFailure("invalid_input", "Choose a file to upload.", 400, { file: ["Choose a file to upload."] })
  }
  if (file.size > IMPORT_MAX_BYTES) {
    return NextResponse.json(SIZE_REFUSAL, { status: 413 })
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const fileName = file instanceof File ? file.name : "statement.csv"
  const profileId = typeof profileIdRaw === "string" && profileIdRaw.length > 0 ? profileIdRaw : undefined

  try {
    const batch = await createBatch(userId, { nodeId, fileName, bytes, profileId })
    revalidatePath("/import")
    return NextResponse.json({ ok: true, data: { batchId: batch.id } })
  } catch (error) {
    const failure = mapImportFailure(error)
    if (!failure) throw error
    return NextResponse.json(failure, { status: statusForImportFailure(failure.error.code) })
  }
}
