import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react"
import type { BudgetStatus } from "@/domain/budgets"
import { cn } from "@/lib/utils"

// The state of a budget in a word and an icon as well as a colour: on track in the accent, near the limit in the notice
// orange the rest of the app uses for "look at this", over in the negative red. Someone who cannot tell the colours apart
// reads the same thing from the text.

const STATUS = {
  ON_TRACK: { label: "On track", Icon: CircleCheck, className: "border-accent-edge/60 bg-accent/10 text-accent-edge" },
  NEAR: { label: "Near limit", Icon: TriangleAlert, className: "border-notice-fg/60 bg-notice-wash text-notice-fg" },
  OVER: { label: "Over budget", Icon: CircleAlert, className: "border-negative/60 bg-negative-wash text-negative" },
} as const

export function StatusChip({ status, className }: { status: BudgetStatus; className?: string }) {
  const { label, Icon, className: tone } = STATUS[status]
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium", tone, className)}>
      <Icon aria-hidden className="size-3.5" />
      {label}
    </span>
  )
}

/** The bar's fill for a status. */
export const BAR_FILL: Record<BudgetStatus, string> = {
  ON_TRACK: "bg-accent",
  NEAR: "bg-notice-fg",
  OVER: "bg-negative",
}
