import { Clock, TriangleAlert } from "lucide-react"

// The parts the balance reports' tables share.
//
// On a phone a table wider than the screen scrolls sideways inside its card, with its first column (the period) held at
// the left. The scroller is padded so focus rings at its edges are not clipped; the held column covers that padding too,
// so the figures scrolling past do not show through beside it.
export const STICKY_CELL =
  "sticky left-0 z-[1] bg-panel before:absolute before:inset-y-0 before:right-full before:w-5 before:bg-panel sm:static sm:bg-transparent sm:before:hidden"

// The words under a row of a report's table that say its figures are not the whole or the current picture: an investment
// left out because it could not be valued, or one counted at a stale price. A row of their own, across the table, so the
// figures above stay in their columns; held at the left edge and to the width of the screen while a wide table scrolls
// sideways, so the note is read without scrolling it into view.

export interface RowNote {
  key: string
  kind: "partial" | "stale"
  text: string
}

export function NoteRow({ colSpan, notes }: { colSpan: number; notes: readonly RowNote[] }) {
  if (notes.length === 0) return null
  return (
    <tr>
      <td colSpan={colSpan} className="pb-3 pt-0">
        <ul className="sticky left-0 w-fit max-w-[min(36rem,calc(100vw-4.5rem))] space-y-1 text-[13px] font-medium text-notice-fg sm:max-w-xl">
          {notes.map((note) => {
            const Icon = note.kind === "partial" ? TriangleAlert : Clock
            return (
              <li key={note.key} className="flex items-start gap-2 rounded-lg bg-notice-wash px-2.5 py-1.5">
                <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>{note.text}</span>
              </li>
            )
          })}
        </ul>
      </td>
    </tr>
  )
}
