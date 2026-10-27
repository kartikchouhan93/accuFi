import { ChevronRight } from "lucide-react"
import { SpotlightCard } from "@/components/ui/spotlight-card"

// The card every chart sits in: a title and a one-sentence summary of what the picture shows, the picture, and under it
// the same figures as a table, behind "View as table". The table is not an extra: it is how the chart is read without
// sight of it, and it holds exactly the text the report passed (money formatted from paise text by the report), so the
// table and the report's other figures cannot disagree. The chart's own geometry is never printed.

export interface ChartTableData {
  /** The header of each column, the first being the rows' labels ("Month"). */
  columns: string[]
  rows: { label: string; cells: string[] }[]
}

export function ChartFrame({ title, summary, table, children }: { title: string; summary: string; table: ChartTableData; children: React.ReactNode }) {
  return (
    <SpotlightCard className="surface rounded-3xl p-5 sm:p-6" radius={460} strength={9}>
      <span aria-hidden className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-accent-edge/60 to-transparent" />
      <figure>
        <figcaption>
          <span className="block font-display text-lg font-semibold tracking-tight">{title}</span>
          <span className="mt-1 block text-sm text-fg-soft">{summary}</span>
        </figcaption>
        <div className="mt-5">{children}</div>
        <ChartTable title={title} table={table} />
      </figure>
    </SpotlightCard>
  )
}

function ChartTable({ title, table }: { title: string; table: ChartTableData }) {
  const [labelColumn, ...valueColumns] = table.columns
  return (
    <details className="group/table mt-5 border-t border-line pt-4">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium text-link [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 transition-transform duration-200 group-open/table:rotate-90" />
        View as table
      </summary>
      <div className="mt-3 overflow-x-auto">
        <table className="figures w-full min-w-max border-collapse text-sm">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className="border-b border-line text-fg-soft">
              <th scope="col" className="py-2 pr-4 text-left font-medium">
                {labelColumn}
              </th>
              {valueColumns.map((column) => (
                <th key={column} scope="col" className="py-2 pl-4 text-right font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr key={`${index}-${row.label}`} className="border-b border-line last:border-0">
                <th scope="row" className="py-2 pr-4 text-left font-medium">
                  {row.label}
                </th>
                {row.cells.map((cell, cellIndex) => (
                  <td key={cellIndex} className="py-2 pl-4 text-right">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
