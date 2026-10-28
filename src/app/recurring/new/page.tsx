import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { AppShell } from "@/app/app-shell"
import type { CalendarDate } from "@/domain/calendar-date"
import type { PickerNode } from "@/lib/transaction-list-view"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { NotFoundError } from "@/server/repositories/errors"
import { loadNewRule, templateFromTransaction } from "@/server/services/recurring-service"
import { blankValues, valuesOfDraft, type RuleFormValues } from "../rule-fields"
import { RuleForm } from "../rule-form"

export const metadata: Metadata = { title: "New recurring rule" }

// A blank form, or, with `?from=<transactionId>` ("Make recurring" on a transaction), one filled in from that transaction.
// An id that names nothing, someone else's transaction, a leg of a split or an entry touching one of the application's own
// accounts is a plain 404: the page says nothing about which of those it was. The form is told only plain data.
export default async function NewRulePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = (await searchParams).from
  const from = Array.isArray(raw) ? raw[0] : raw // a repeated parameter is a hand-edited URL: the first is as good as any
  let page: { nodes: PickerNode[]; today: CalendarDate; initial: RuleFormValues }
  try {
    const userId = await requireUserId()
    if (from === undefined) {
      const { nodes, today } = await loadNewRule(userId)
      page = { nodes, today, initial: blankValues(today) }
    } else {
      const { draft, nodes, today } = await templateFromTransaction(userId, from)
      page = { nodes, today, initial: valuesOfDraft(draft) }
    }
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    if (error instanceof NotFoundError) notFound()
    throw error
  }
  return (
    <AppShell current="recurring">
      <main className="mx-auto max-w-2xl px-4 pb-28 pt-8 sm:px-8">
        <Link href="/recurring" className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-link underline underline-offset-4">
          <ArrowLeft aria-hidden className="size-4" />
          Recurring
        </Link>
        <h1 className="mt-4 font-display text-3xl font-semibold tracking-tight sm:text-4xl">New rule</h1>
        <p className="mt-2 text-fg-soft">
          A rule proposes an entry on each date it falls due. You post it, or skip it, from your Recurring inbox, unless you
          choose to post automatically.
        </p>
        <div className="mt-6">
          <RuleForm nodes={page.nodes} today={page.today} initial={page.initial} editing={null} />
        </div>
      </main>
    </AppShell>
  )
}
