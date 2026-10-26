import { Amount } from "@/app/amount"
import { PriceLine } from "@/app/price-line"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { KIND_ICON } from "@/app/nodes/kind-icons"
import { NOT_VALUED_COPY, type NotValuedReason, type PriceState } from "@/lib/investment-view"
import { HOLDING_KINDS } from "@/lib/node-kinds"
import { describeBalance } from "@/lib/node-money"
import type { PickerNode } from "@/lib/transaction-list-view"
import { groupByKind } from "./pickers"

// What each account, investment and card holds or owes right now, beside the form that changes it. "Right now" is the
// server's: transactions dated after today are not in these figures. A card you owe on reads as money owed, once:
// describeBalance turns the negative balance into the amount and the word, and nothing here negates it again. No total
// is drawn, so there is nothing here that could disagree with the rows above it; net worth is the ledger screen's.
//
// An investment held by lots reads as it does on the ledger and the dashboard, from the same figures: its value today with
// the day of the price behind it (and Stale once that price is old, EC-24), or "Not valued" and why, never a figure it
// does not have (EC-23). One valued by what was put in shows that money.

interface Props {
  nodes: PickerNode[]
  balances: Record<string, string>
  unvalued: Record<string, NotValuedReason>
  priced: Record<string, PriceState>
}

export function Balances({ nodes, balances, unvalued, priced }: Props) {
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
                      <Figure kind={node.kind} balance={balances[node.id] ?? "0"} notValued={unvalued[node.id]} priced={priced[node.id]} />
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

function Figure({ kind, balance, notValued, priced }: { kind: PickerNode["kind"]; balance: string; notValued?: NotValuedReason; priced?: PriceState }) {
  if (notValued) {
    return (
      <span className="shrink-0 text-right">
        <span className="block font-medium text-fg-soft">Not valued</span>
        <span className="block text-xs text-fg-soft">{NOT_VALUED_COPY[notValued]}</span>
      </span>
    )
  }
  if (priced) {
    return (
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <Amount text={describeBalance(kind, balance)} />
        <PriceLine priced={priced} className="justify-end" />
      </span>
    )
  }
  return <Amount text={describeBalance(kind, balance)} />
}
