import { ArrowDownLeft, ArrowUpRight, CircleAlert } from "lucide-react"
import { Amount } from "@/app/amount"
import { figure } from "@/app/feedback"
import type { ImportDirection } from "@/domain/import-map"
import type { PreviewRow } from "@/server/services/import-service"

// The first 20 rows of the batch, exactly as staging would record them (design §6 stage 2): a date, a description, an
// amount through the same `Amount`/`figure()` every other screen uses (never a JS number, however many digits), and a
// direction chip that never relies on colour alone. A row with no error and no parsed value yet is the "choose your
// columns" prompt, not a mistake; a row with an error shows its reason and nothing else, since its cells could not be
// turned into a transaction. The table is wide (eight columns across), so it scrolls inside its own labelled, focusable
// frame rather than the page: the global no-horizontal-scroll rule is about the page, not a table built to compare rows.

const DIRECTION: Record<ImportDirection, { label: string; Icon: typeof ArrowUpRight }> = {
  OUT: { label: "Out", Icon: ArrowUpRight },
  IN: { label: "In", Icon: ArrowDownLeft },
}

function DirectionChip({ direction }: { direction: ImportDirection }) {
  const { label, Icon } = DIRECTION[direction]
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium text-fg-soft">
      <Icon aria-hidden className="size-3.5" />
      {label}
    </span>
  )
}

function monthDay(occurredOn: string): string {
  const [year, month, day] = occurredOn.split("-")
  return `${day}/${month}/${year}`
}

export function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  if (rows.length === 0) {
    return <p className="mt-3 text-sm text-fg-soft">There are no data rows to preview: check the header rows and delimiter above.</p>
  }
  return (
    <div
      role="region"
      aria-label="Preview of the first 20 rows, as they will be recorded"
      tabIndex={0}
      className="mt-3 overflow-x-auto rounded-2xl border border-line-strong focus-visible:ring-4 focus-visible:ring-accent/20"
    >
      <table className="w-full min-w-[40rem] text-left text-sm">
        <caption className="sr-only">Preview of the first 20 rows, as they will be recorded</caption>
        <thead className="border-b border-line-strong bg-panel-raised text-xs font-medium text-fg-soft">
          <tr>
            <th scope="col" className="px-3 py-2">
              Line
            </th>
            <th scope="col" className="px-3 py-2">
              Date
            </th>
            <th scope="col" className="px-3 py-2">
              Description
            </th>
            <th scope="col" className="px-3 py-2">
              Direction
            </th>
            <th scope="col" className="px-3 py-2 text-right">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.line} className="border-b border-line last:border-0">
              <td className="figures px-3 py-2 text-fg-soft">{row.line}</td>
              {row.error ? (
                <td colSpan={4} className="px-3 py-2">
                  <span className="flex items-start gap-1.5 font-medium text-negative">
                    <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                    {row.error}
                  </span>
                </td>
              ) : row.parsed ? (
                <>
                  <td className="figures px-3 py-2 whitespace-nowrap">{monthDay(row.parsed.occurredOn)}</td>
                  <td className="px-3 py-2 [overflow-wrap:anywhere]">{row.parsed.description || <span className="text-fg-soft">(no description)</span>}</td>
                  <td className="px-3 py-2">
                    <DirectionChip direction={row.parsed.direction} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Amount text={figure(row.parsed.amountPaise)} />
                  </td>
                </>
              ) : (
                <td colSpan={4} className="px-3 py-2 text-fg-soft">
                  Choose the date and amount columns below to see this row.
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
