import Link from "next/link"
import { transactionsHref, type Drill } from "@/lib/report-drill"
import { cn } from "@/lib/utils"

// A figure or a name on a report that opens the entries it is made of: the Transactions screen filtered by its drill, so
// its total there is the figure here. Underlined with a quiet dotted line, so a column of figures still reads as figures
// while saying every one of them can be followed; the line and the text take the link colour on hover. A bare figure says
// nothing out of its table ("₹21,500.00"), so `context` is read after the visible text by a screen reader only
// (", spending, Jan 2026"), and a list of the page's links still says what each one opens.

interface Props {
  drill: Drill
  /** Announced after the visible text, never shown: what the figure is of. */
  context?: string
  className?: string
  children: React.ReactNode
}

export function DrillLink({ drill, context, className, children }: Props) {
  return (
    <Link
      href={transactionsHref(drill)}
      className={cn(
        "rounded-md underline decoration-line-strong decoration-dotted decoration-1 underline-offset-[5px] transition-colors hover:text-link hover:decoration-solid hover:decoration-current",
        className,
      )}
    >
      {children}
      {context && <span className="sr-only">{context}</span>}
    </Link>
  )
}
