"use client"

import { CircleAlert, LoaderCircle, Upload } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useRef, useState } from "react"
import { Field } from "@/app/transactions/transaction-form"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { buttonClass, inputClass } from "@/components/ui/styles"
import { readUploadResponse, SESSION_EXPIRED_MESSAGE } from "./upload-response"

// The first screen of an import: the browser's own `fetch`/`FormData`, straight to the upload route
// (src/app/api/import/upload/route.ts) — a multipart file cannot travel through a Server Action in this app's
// pattern. Field errors from the route (account, file) are shown beside their own field; anything else is one
// message above the buttons; an answer that is not the route's JSON at all is a lapsed session (ruling R2,
// upload-response.ts). A successful upload navigates straight to the new batch's map screen; nothing here shows the
// file's own content, only its name.

interface Account {
  id: string
  name: string
  kind: "ASSET" | "LIABILITY"
}

interface Profile {
  id: string
  name: string
  nodeId: string | null
}

const KIND_LABEL: Record<Account["kind"], string> = { ASSET: "Asset accounts", LIABILITY: "Liability accounts" }

function groupAccounts(accounts: Account[]): { kind: Account["kind"]; accounts: Account[] }[] {
  return (["ASSET", "LIABILITY"] as const)
    .map((kind) => ({ kind, accounts: accounts.filter((a) => a.kind === kind) }))
    .filter((group) => group.accounts.length > 0)
}

export function UploadForm({ accounts, profiles }: { accounts: Account[]; profiles: Profile[] }) {
  const router = useRouter()
  const inFlight = useRef(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [nodeId, setNodeId] = useState("")
  const [profileId, setProfileId] = useState("")
  const [fileName, setFileName] = useState("")
  const [pending, setPending] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})
  const [message, setMessage] = useState<string | null>(null)
  const groups = groupAccounts(accounts)

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const file = fileRef.current?.files?.[0] ?? null
    const problems: Record<string, string[]> = {}
    if (nodeId === "") problems.nodeId = ["Choose an account"]
    if (!file) problems.file = ["Choose a file to upload"]
    if (Object.keys(problems).length > 0) {
      setFieldErrors(problems)
      setMessage(null)
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setFieldErrors({})
    setMessage(null)
    try {
      const form = new FormData()
      form.set("nodeId", nodeId)
      form.set("file", file!)
      if (profileId !== "") form.set("profileId", profileId)

      let response: Response
      try {
        response = await fetch("/api/import/upload", { method: "POST", body: form })
      } catch {
        setMessage("Could not reach the server. Check your connection and try again.")
        return
      }

      // Ruling R2: a non-JSON 200 (the login page after a lapsed session's redirect) is an expired session, never a
      // success and never an uncaught parse error. Ruling R9: a non-JSON, non-200 answer is a proxy rejecting the
      // request itself, named by its status rather than shown as the same "session expired" message.
      const outcome = await readUploadResponse(response)
      if (outcome.kind === "expired") {
        setMessage(SESSION_EXPIRED_MESSAGE)
        return
      }
      if (outcome.kind === "blocked") {
        setMessage(
          outcome.status === 413
            ? "A server in front of this app rejected the file as too large (not this app's own 5 MB limit). Try a smaller file, or ask whoever runs the server to raise its upload size limit."
            : `The server rejected the request (status ${outcome.status}). Check your connection and try again.`,
        )
        return
      }
      if (outcome.kind === "failed") {
        setFieldErrors(outcome.failure.fieldErrors ?? {})
        setMessage(outcome.failure.fieldErrors ? null : outcome.failure.message)
        return
      }
      router.push(`/import/${outcome.batchId}/map`)
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return (
    <SpotlightCard className="surface rounded-3xl" radius={340} strength={10}>
      <form onSubmit={send} noValidate aria-label="New import" className="p-5 sm:p-6">
        <div className="space-y-4">
          <Field idBase="import-account" label="Account" errors={fieldErrors.nodeId}>
            {(props) => (
              <select
                {...props}
                value={nodeId}
                onChange={(event) => setNodeId(event.target.value)}
                className={inputClass}
              >
                <option value="">Choose an account</option>
                {groups.map((group) => (
                  <optgroup key={group.kind} label={KIND_LABEL[group.kind]}>
                    {group.accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
          </Field>

          <Field idBase="import-file" label="Statement file" hint="A CSV file, up to 5 MB" errors={fieldErrors.file}>
            {(props) => (
              <input
                {...props}
                ref={fileRef}
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")}
                className={`${inputClass} py-2 file:mr-3 file:h-full file:rounded-lg file:border-0 file:bg-panel-raised file:px-3 file:text-sm file:font-medium file:text-fg`}
              />
            )}
          </Field>
          {fileName !== "" && <p className="text-sm text-fg-soft">Chosen: {fileName}</p>}

          {profiles.length > 0 && (
            <Field idBase="import-profile" label="Mapping" optional hint="Reuse a saved mapping from an earlier import" errors={undefined}>
              {(props) => (
                <select {...props} value={profileId} onChange={(event) => setProfileId(event.target.value)} className={inputClass}>
                  <option value="">Choose columns after uploading</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
        </div>

        {message && (
          <p role="alert" className="mt-4 flex items-start gap-2.5 rounded-xl bg-negative-wash px-3.5 py-2.5 text-sm font-medium text-negative">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{message}</span>
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="submit" aria-disabled={pending} className={buttonClass({ className: "aria-disabled:opacity-55" })}>
            {pending && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
            <Upload aria-hidden className="size-4" />
            Upload
          </button>
          <Link href="/import" className="rounded-md text-sm font-medium text-link underline underline-offset-4">
            Cancel
          </Link>
        </div>
      </form>
    </SpotlightCard>
  )
}
