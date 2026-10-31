import Link from "next/link"
import { Amount } from "@/app/amount"
import { figure } from "@/app/recurring/feedback"
import { monthLabel, type BudgetHistoryRow } from "@/lib/budget-view"
import { StatusChip } from "./status-chip"

// A budget month by month, newest first: what was used, what was available and how it ended, with the used amount leading
// to exactly the entries it is made of. An over month says so in words. The table scrolls sideways inside its own frame if a
// very long amount needs it (the frame can be reached by keyboard), so the page itself never does.

export function HistoryTable({ name, rows }: { name: string; rows: BudgetHistoryRow[] }) {
  return (
    <div role="region" aria-label={`Past months for ${name}`} tabIndex={0} className="mt-4 overflow-x-auto rounded-xl border border-line bg-canvas/60">
      <table className="w-full min-w-max text-left text-sm">
        <caption className="sr-only">{name} budget, month by month</caption>
        <thead>
          <tr className="border-b border-line text-fg-soft">
            <th scope="col" className="px-3.5 py-2.5 font-medium">
              Month
            </th>
            <th scope="col" className="px-3.5 py-2.5 font-medium">
              Used
            </th>
            <th scope="col" className="hidden px-3.5 py-2.5 font-medium sm:table-cell">
              Available
            </th>
            <th scope="col" className="hidden px-3.5 py-2.5 font-medium sm:table-cell">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.month} className="border-b border-line last:border-b-0">
              <th scope="row" className="whitespace-nowrap px-3.5 py-2.5 align-top font-medium">
                {monthLabel(row.month)}
                {/* On a narrow screen the status sits under the month and the available amount under the used one, so nothing needs a sideways scroll. */}
                <StatusChip status={row.status} className="mt-1.5 flex w-fit sm:hidden" />
              </th>
              <td className="px-3.5 py-2.5 align-top">
                <Link href={row.drillHref} className="rounded-md underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-accent-edge">
                  <Amount text={figure(row.usedPaise)} />
                  <span className="sr-only">
                    {" "}
                    {name} {monthLabel(row.month)}, see the entries
                  </span>
                </Link>
                <span className="mt-1 block text-fg-soft sm:hidden">
                  of <Amount text={figure(row.availablePaise)} />
                </span>
              </td>
              <td className="hidden px-3.5 py-2.5 sm:table-cell">
                <Amount text={figure(row.availablePaise)} className="text-fg-soft" />
              </td>
              <td className="hidden px-3.5 py-2.5 sm:table-cell">
                <StatusChip status={row.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
