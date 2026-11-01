import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { AppShell } from "@/app/app-shell"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import type { ImportMapping } from "@/domain/import-map"
import { NotFoundError } from "@/server/repositories/errors"
import { loadMapScreen, loadProfileMapping } from "@/server/services/import-service"
import { mappingFromParams } from "../../mapping-params"
import { MapForm } from "./map-form"

export const metadata: Metadata = { title: "Map import" }

/** One value per name: a repeated parameter is a hand-edited URL, and the first value is as good as any. */
const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value)

function flatten(params: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(params)) flat[key] = first(value)
  return flat
}

// The map-and-preview screen (design §6 stage 2). GET-driven: the mapping lives entirely in the URL's search
// parameters (mapping-params.ts), so every control change is a plain navigation and the preview below is
// recomputed here, on the server, with nothing kept in the browser between one request and the next. A `profile`
// parameter is resolved separately (it names a saved mapping, not a field of one) and, when it reads, replaces the
// mapping outright for this one request rather than merging field by field.
export default async function MapPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const flat = flatten(await searchParams)

  let userId: string
  let base: Awaited<ReturnType<typeof loadMapScreen>>
  try {
    userId = await requireUserId()
    base = await loadMapScreen(userId, id)
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    if (error instanceof NotFoundError) notFound()
    throw error
  }

  if (Object.keys(flat).length === 0) {
    return <MapScreenPage id={id} screen={base} />
  }

  const profileId = flat.profile
  let mapping: ImportMapping
  if (profileId) {
    const profileMapping = await loadProfileMapping(userId, profileId)
    mapping = profileMapping ?? mappingFromParams(flat, base.mapping)
  } else {
    mapping = mappingFromParams(flat, base.mapping)
  }

  const screen = await loadMapScreen(userId, id, mapping)
  return <MapScreenPage id={id} screen={screen} />
}

function MapScreenPage({ id, screen }: { id: string; screen: Awaited<ReturnType<typeof loadMapScreen>> }) {
  return (
    <AppShell current="import">
      <main className="mx-auto max-w-4xl px-4 pb-28 pt-8 sm:px-8">
        <Link href="/import" className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-link underline underline-offset-4">
          <ArrowLeft aria-hidden className="size-4" />
          Import
        </Link>
        <h1 className="mt-4 font-display text-3xl font-semibold tracking-tight sm:text-4xl [overflow-wrap:anywhere]">{screen.batch.fileName}</h1>
        <p className="mt-2 text-fg-soft">
          Onto {screen.account.name}. Choose how to read each column, check the preview, then stage the rows to decide them one by one.
        </p>
        <div className="mt-6">
          <MapForm batchId={id} basePath={`/import/${id}/map`} screen={screen} />
        </div>
      </main>
    </AppShell>
  )
}
