import type { LotView } from "@/lib/investment-view"
import { quantityText } from "@/lib/investment-text"
import { formatPaiseText } from "@/lib/node-money"
import { formatDay } from "@/lib/transaction-text"
import { cn } from "@/lib/utils"

// The purchases a holding is made of, oldest first (the order FIFO sells them): when each was bought, how much, how much
// of it is still held, and what it cost. A lot that has been sold out stays listed, dimmed, so the history of what a sale
// took is visible. A real table, so a screen reader can read it by row and column; on a very narrow screen it scrolls
// inside its own frame rather than widening the page.

// Tight on a phone, so four columns fit a 390px screen without scrolling; roomier from the small breakpoint up.
const CELL = "px-1.5 py-2 first:pl-3 last:pr-3 sm:px-3"

export function LotTable({ name, unit, lots }: { name: string; unit: string | null; lots: LotView[] }) {
  if (lots.length === 0) return <p className="text-fg-soft">No purchases yet.</p>
  return (
    <div className="-mx-1 overflow-x-auto rounded-xl border border-line bg-canvas/60">
      <table className="figures w-full text-[13px] sm:text-sm">
        <caption className="sr-only">Lots of {name}</caption>
        <thead>
          <tr className="border-b border-line text-left text-xs font-medium text-fg-soft">
            <th scope="col" className={cn(CELL, "font-medium")}>
              Bought
            </th>
            <th scope="col" className={cn(CELL, "text-right font-medium")}>
              Quantity
            </th>
            <th scope="col" className={cn(CELL, "text-right font-medium")}>
              Remaining
            </th>
            <th scope="col" className={cn(CELL, "text-right font-medium")}>
              Cost
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {lots.map((lot) => {
            const soldOut = lot.quantityRemaining === "0"
            return (
              <tr key={lot.id} className={cn("transition-colors duration-200 hover:bg-panel-raised", soldOut && "text-fg-soft")}>
                <td className={cn(CELL, "whitespace-nowrap")}>{formatDay(lot.acquiredAt)}</td>
                <td className={cn(CELL, "whitespace-nowrap text-right")}>{quantityText(lot.quantity, unit)}</td>
                <td className={cn(CELL, "whitespace-nowrap text-right")}>{soldOut ? "Sold" : quantityText(lot.quantityRemaining, unit)}</td>
                <td className={cn(CELL, "whitespace-nowrap text-right")}>
                  {formatPaiseText(lot.costBasisPaise)}
                  {lot.costBasisRemainingPaise !== lot.costBasisPaise && !soldOut && (
                    <span className="block text-xs text-fg-soft">{formatPaiseText(lot.costBasisRemainingPaise)} left</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
