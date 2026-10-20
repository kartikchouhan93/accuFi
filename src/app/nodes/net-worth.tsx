import { PartialNote } from "@/app/partial-note"
import { HOLDING_KINDS } from "@/lib/node-kinds"
import { describeBalance, formatPaiseText } from "@/lib/node-money"
import type { NodeOverview } from "@/lib/node-overview"

// What you own less what you owe, from the server's total: summed over every node, archived ones included. The
// liabilities figure is already the positive amount owed (the total has subtracted it), so it is printed as it comes.

export function NetWorth({ overview }: { overview: NodeOverview }) {
  const { netWorth, kinds, nodes } = overview
  const unvalued = nodes.filter((node) => netWorth.unvaluedNodeIds.includes(node.id)).map((node) => node.name)
  const total = describeBalance("ASSET", netWorth.total) // a signed amount: negative reads in red with its minus sign
  const archived = (Object.keys(kinds) as (keyof typeof kinds)[])
    .filter((kind) => HOLDING_KINDS.has(kind))
    .reduce((sum, kind) => sum + kinds[kind].archivedCount, 0)

  return (
    <section aria-labelledby="net-worth-heading">
      <h2 id="net-worth-heading" className="font-display text-lg font-semibold">
        Net worth
      </h2>
      <p className={`figures mt-1 pb-2 text-4xl font-medium sm:text-5xl ${total.tone === "negative" ? "text-red" : ""} double-rule`}>
        {total.amount}
      </p>
      {netWorth.isPartial && <PartialNote names={unvalued} />}
      <p className="figures mt-2 text-sm text-ink-soft">
        {formatPaiseText(netWorth.assets)} in accounts, {formatPaiseText(netWorth.investments)} invested,{" "}
        {formatPaiseText(netWorth.liabilities)} owed.
        {archived > 0 && ` Includes ${archived} archived.`}
      </p>
    </section>
  )
}
