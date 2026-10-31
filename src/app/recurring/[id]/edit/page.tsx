import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { AppShell } from "@/app/app-shell"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { NotFoundError } from "@/server/repositories/errors"
import { loadRuleForEdit } from "@/server/services/recurring-service"
import { valuesOfRule } from "../../rule-fields"
import { RuleForm } from "../../rule-form"

export const metadata: Metadata = { title: "Edit recurring rule" }

// The rule as it is stored now, in a form that sends the version it was opened at. A rule that is not the user's, or is
// deleted, is a plain 404. The form is keyed by the version, so reloading after a conflict (a refresh of this page) starts
// it over from what is stored instead of keeping what was typed.
export default async function EditRulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let loaded: Awaited<ReturnType<typeof loadRuleForEdit>>
  try {
    loaded = await loadRuleForEdit(await requireUserId(), id)
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    if (error instanceof NotFoundError) notFound()
    throw error
  }
  const { rule, nodes, today, occurrences, lastDueOn } = loaded
  return (
    <AppShell current="recurring">
      <main className="mx-auto max-w-2xl px-4 pb-28 pt-8 sm:px-8">
        <Link href="/recurring" className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-link underline underline-offset-4">
          <ArrowLeft aria-hidden className="size-4" />
          Recurring
        </Link>
        <h1 className="mt-4 font-display text-3xl font-semibold tracking-tight sm:text-4xl">Edit rule</h1>
        <p className="mt-2 text-fg-soft">
          A change applies to the entries it makes from now on. What it has already posted, and what is waiting in your inbox,
          stays as it is.
        </p>
        <div className="mt-6">
          <RuleForm
            key={`${rule.id}:${rule.version}`}
            nodes={nodes}
            today={today}
            initial={valuesOfRule(rule, today, lastDueOn)}
            editing={{ id: rule.id, version: rule.version, occurrences, lastDueOn, paused: rule.state === "paused" }}
          />
        </div>
      </main>
    </AppShell>
  )
}
