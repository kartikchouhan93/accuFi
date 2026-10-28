import { ArrowRight, Repeat } from "lucide-react"
import Link from "next/link"

// One line on the dashboard, only when recurring entries are waiting: "3 entries waiting", linking to the inbox. Nothing
// else about recurring entries is on the dashboard. A count of zero draws nothing, so the caller need not guard it.

export function PendingNotice({ count }: { count: number }) {
  if (!(count > 0)) return null
  return (
    <Link
      href="/recurring"
      className="surface mt-6 flex w-fit max-w-full items-center gap-2.5 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors hover:border-accent-edge hover:bg-panel-raised"
    >
      <Repeat aria-hidden className="size-4 shrink-0 text-accent-edge" />
      {count} {count === 1 ? "entry" : "entries"} waiting
      <ArrowRight aria-hidden className="size-4 shrink-0 text-fg-soft" />
    </Link>
  )
}
