import { Amount } from "@/app/amount"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { KIND_ICON } from "@/app/nodes/kind-icons"
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
      <h2 id="balances-heading" className="font-display text-xl font-semibold tracking-tight">
        Balances
      </h2>
      {groups.length === 0 ? (
        <p className="mt-2 text-fg-soft">No accounts yet. Add one on the Ledger screen, then record money moving through it.</p>
      ) : (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {groups.map((group, index) => {
            const Icon = group.kind === "SETUP" ? null : KIND_ICON[group.kind]
            return (
              <SpotlightCard
                key={group.kind}
                className="surface rise rounded-2xl p-4"
                style={{ "--i": index } as React.CSSProperties}
                radius={260}
                strength={9}
              >
                <h3 className="flex items-center gap-2 text-sm font-semibold text-fg-soft">
                  {Icon && <Icon aria-hidden className="size-4" />}
                  {group.label}
                </h3>
                <ul className="mt-2 divide-y divide-line">
                  {group.nodes.map((node) => (
                    <li key={node.id} className="flex items-baseline justify-between gap-3 py-2">
                      <span className="min-w-0 truncate font-medium">{node.name}</span>
                      <Amount text={describeBalance(node.kind, balances[node.id] ?? "0")} />
                    </li>
                  ))}
                </ul>
              </SpotlightCard>
            )
          })}
        </div>
      )}
    </section>
  )
}
