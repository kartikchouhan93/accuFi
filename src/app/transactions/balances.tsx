import { Amount } from "@/app/amount"
import { HOLDING_KINDS } from "@/lib/node-kinds"
import { describeBalance } from "@/lib/node-money"
import type { PickerNode } from "@/lib/transaction-list-view"
import { groupByKind } from "./pickers"

// What each account, investment and card holds or owes right now, beside the form that changes it. "Right now" is the
// server's: transactions dated after today are not in these figures. A card you owe on reads as money owed, once:
// describeBalance turns the negative balance into the amount and the word, and nothing here negates it again. No total
// is drawn, so there is nothing here that could disagree with the rows above it; net worth is the ledger screen's.

export function Balances({ nodes, balances }: { nodes: PickerNode[]; balances: Record<string, string> }) {
  const holding = nodes.filter((node) => HOLDING_KINDS.has(node.kind) && !node.archived && node.systemRole === null)
  const groups = groupByKind(holding)
  return (
    <section aria-labelledby="balances-heading">
      <h2 id="balances-heading" className="font-display text-xl font-semibold">
        Balances
      </h2>
      {groups.length === 0 ? (
        <p className="mt-2 text-ink-soft">No accounts yet. Add one on the Ledger screen, then record money moving through it.</p>
      ) : (
        <div className="mt-2 grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {groups.map((group) => (
            <div key={group.kind}>
              <h3 className="border-b-2 border-ink pb-0.5 text-sm font-semibold text-ink-soft">{group.label}</h3>
              <ul className="divide-y divide-rule">
                {group.nodes.map((node) => (
                  <li key={node.id} className="flex items-baseline gap-3 py-1.5">
                    <span className="font-medium">{node.name}</span>
                    <span className="leader" aria-hidden="true" />
                    <Amount text={describeBalance(node.kind, balances[node.id] ?? "0")} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
