import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { AppShell } from "@/app/app-shell"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { loadBudgetForm } from "@/server/services/budget-report"
import { BudgetForm } from "../budget-form"

export const metadata: Metadata = { title: "New budget" }

// A blank form: the user's own live expense ledgers and today in their zone. Nothing here is addressed by an id, so there is
// no not-found case; the route guard sends anyone without a session to /login before this runs.
export default async function NewBudgetPage() {
  let loaded: Awaited<ReturnType<typeof loadBudgetForm>>
  try {
    loaded = await loadBudgetForm(await requireUserId())
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    throw error
  }
  return (
    <AppShell current="budgets">
      <main className="mx-auto max-w-2xl px-4 pb-28 pt-8 sm:px-8">
        <Link href="/budgets" className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-link underline underline-offset-4">
          <ArrowLeft aria-hidden className="size-4" />
          Budgets
        </Link>
        <h1 className="mt-4 font-display text-3xl font-semibold tracking-tight sm:text-4xl">New budget</h1>
        <p className="mt-2 text-fg-soft">
          A monthly limit on an expense ledger. It counts what you spend on the ledger and the ledgers inside it, and never stops you
          recording anything.
        </p>
        <div className="mt-6">
          <BudgetForm nodes={loaded.nodes} today={loaded.today} budget={null} />
        </div>
      </main>
    </AppShell>
  )
}
