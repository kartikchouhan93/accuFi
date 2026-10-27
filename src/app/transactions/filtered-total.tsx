import { formatPaiseText } from "@/lib/node-money"

// The net movement across the ledgers the list is filtered to (the Involving choice, or what Counted as stands for), from
// outside them: what came in less what went out. It is computed on the server over the same entries as the list, not summed
// from the rows shown, so it holds past the first page. Paise text arrives signed; the wording carries the sign, so the
// figure is shown without one.

export function FilteredTotal({ paise, deleted }: { paise: string; deleted: boolean }) {
  const negative = paise.startsWith("-")
  return (
    <p className="surface rounded-3xl px-5 py-4 text-sm text-fg-soft">
      {negative ? "Net out of these ledgers" : "Net into these ledgers"}{" "}
      <span className="figures text-base font-semibold text-fg">{formatPaiseText(negative ? paise.slice(1) : paise)}</span>
      {deleted && <span className="ml-2">Counts live entries only.</span>}
    </p>
  )
}
