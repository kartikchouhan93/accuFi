import { ArrowRight, PiggyBank } from "lucide-react"
import Link from "next/link"

// One line on the dashboard, only when a budget is near or over this month: "2 budgets need attention", linking to the
// budgets screen. A count of zero draws nothing, so the caller need not guard it.

export function BudgetNotice({ count }: { count: number }) {
  if (!(count > 0)) return null
  return (
    <Link
      href="/budgets"
      className="surface mt-6 flex w-fit max-w-full items-center gap-2.5 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors hover:border-accent-edge hover:bg-panel-raised"
    >
      <PiggyBank aria-hidden className="size-4 shrink-0 text-accent-edge" />
      {count === 1 ? "1 budget needs attention" : `${count} budgets need attention`}
      <ArrowRight aria-hidden className="size-4 shrink-0 text-fg-soft" />
    </Link>
  )
}
