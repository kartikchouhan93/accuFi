import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { AppShell } from "@/app/app-shell"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { NotFoundError } from "@/server/repositories/errors"
import { loadBudgetForm } from "@/server/services/budget-report"
import { BudgetForm } from "../../budget-form"

export const metadata: Metadata = { title: "Edit budget" }

// The budget, its ledger and today in the user's zone. An id that names nothing, or someone else's budget, is a plain 404:
// the page says nothing about which of those it was. The form is told only plain data (paise as text, months as
// "YYYY-MM-01") and is keyed by the budget, so it starts over from what is stored whenever it is another budget.
export default async function EditBudgetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let loaded: Awaited<ReturnType<typeof loadBudgetForm>>
  try {
    loaded = await loadBudgetForm(await requireUserId(), id)
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    if (error instanceof NotFoundError) notFound()
    throw error
  }
  const { budget, nodes, today } = loaded
  if (!budget) notFound() // its ledger is gone: nothing to show a budget on
  return (
    <AppShell current="budgets">
      <main className="mx-auto max-w-2xl px-4 pb-28 pt-8 sm:px-8">
        <Link href="/budgets" className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-link underline underline-offset-4">
          <ArrowLeft aria-hidden className="size-4" />
          Budgets
        </Link>
        <h1 className="mt-4 font-display text-3xl font-semibold tracking-tight sm:text-4xl">Edit budget</h1>
        <p className="mt-2 text-fg-soft">
          Change the amount from a month on, or when the budget ends and whether it carries over. Past months are measured against
          the amount that applied to them.
        </p>
        <div className="mt-6">
          <BudgetForm key={budget.id} nodes={nodes} today={today} budget={budget} />
        </div>
      </main>
    </AppShell>
  )
}
