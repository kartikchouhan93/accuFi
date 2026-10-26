import { cn } from "@/lib/utils"

/** A small outlined label beside a name or a figure: "System", "Archived", "Stale". */
export function Tag({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("rounded-full border border-line-strong px-2 py-0.5 text-[11px] font-medium text-fg-soft", className)}>{children}</span>
  )
}
