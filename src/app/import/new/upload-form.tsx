"use client"

import { CircleAlert, LoaderCircle, Upload } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useRef, useState } from "react"
import { Field } from "@/app/transactions/transaction-form"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { buttonClass, inputClass } from "@/components/ui/styles"

// The first screen of an import: the browser's own `fetch`/`FormData`, straight to the upload route
// (src/app/api/import/upload/route.ts) — a multipart file cannot travel through a Server Action in this app's
// pattern. Field errors from the route (account, file) are shown beside their own field; anything else is one
// message above the buttons. A successful upload navigates straight to the new batch's map screen; nothing here
// shows the file's own content, only its name.

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

interface UploadFailure {
  code: string
  message: string
  fieldErrors?: Record<string, string[]>
}

const KIND_LABEL: Record<Account["kind"], string> = { ASSET: "Asset accounts", LIABILITY: "Liability accounts" }

function groupAccounts(accounts: Account[]): { kind: Account["kind"]; accounts: Account[] }[] {
  return (["ASSET", "LIABILITY"] as const)
    .map((kind) => ({ kind, accounts: accounts.filter((a) => a.kind === kind) }))
    .filter((group) => group.accounts.length > 0)
}

async function parseFailure(response: Response): Promise<UploadFailure> {
  try {
    const body = (await response.json()) as { ok: false; error: UploadFailure }
    return body.error
  } catch {
    return { code: "invalid", message: "Something went wrong. Check your connection and try again." }
  }
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

      if (!response.ok) {
        const failure = await parseFailure(response)
        setFieldErrors(failure.fieldErrors ?? {})
        setMessage(failure.fieldErrors ? null : failure.message)
        return
      }

      const body = (await response.json()) as { ok: true; data: { batchId: string } }
      router.push(`/import/${body.data.batchId}/map`)
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
