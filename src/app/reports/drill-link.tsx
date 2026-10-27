import Link from "next/link"
import { transactionsHref, type Drill } from "@/lib/report-drill"
import { cn } from "@/lib/utils"

// A figure or a name on a report that opens the entries it is made of: the Transactions screen filtered by its drill, so
// its total there is the figure here. Underlined with a quiet dotted line, so a column of figures still reads as figures
// while saying every one of them can be followed; the line and the text take the link colour on hover.

export function DrillLink({ drill, className, children }: { drill: Drill; className?: string; children: React.ReactNode }) {
  return (
    <Link
      href={transactionsHref(drill)}
      className={cn(
        "rounded-md underline decoration-line-strong decoration-dotted decoration-1 underline-offset-[5px] transition-colors hover:text-link hover:decoration-solid hover:decoration-current",
        className,
      )}
    >
      {children}
    </Link>
  )
}
