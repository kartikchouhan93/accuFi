import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { AppShell } from "@/app/app-shell"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { loadNewImport } from "@/server/services/import-service"
import { UploadForm } from "./upload-form"

export const metadata: Metadata = { title: "New import" }

// A blank upload form: the user's own live asset or liability accounts, and any mapping profiles they have saved.
// Nothing here is addressed by an id, so there is no not-found case; the route guard sends anyone without a session
// to /login before this runs.
export default async function NewImportPage() {
  let loaded: Awaited<ReturnType<typeof loadNewImport>>
  try {
    loaded = await loadNewImport(await requireUserId())
  } catch (error) {
    redirectIfUnauthenticated(error)
    throw error
  }
  return (
    <AppShell current="import">
      <main className="mx-auto max-w-2xl px-4 pb-28 pt-8 sm:px-8">
        <Link href="/import" className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-link underline underline-offset-4">
          <ArrowLeft aria-hidden className="size-4" />
          Import
        </Link>
        <h1 className="mt-4 font-display text-3xl font-semibold tracking-tight sm:text-4xl">New import</h1>
        <p className="mt-2 text-fg-soft">
          Choose the account a statement is for and the CSV file itself. You will choose how to read its columns, and see
          a preview, before anything is recorded.
        </p>
        <div className="mt-6">
          <UploadForm accounts={loaded.accounts} profiles={loaded.profiles} />
        </div>
      </main>
    </AppShell>
  )
}
