import { TriangleAlert } from "lucide-react"

// The words that go next to a net worth that is not the whole figure: an investment that could not be valued is left out
// of the total, and a lower number must not pass for the whole picture. Shared by the dashboard and the ledger screen.
export function PartialNote({ names }: { names: readonly string[] }) {
  return (
    <p role="note" className="mt-5 flex max-w-xl items-start gap-2.5 rounded-xl bg-notice-wash px-3.5 py-2.5 text-sm font-medium text-notice-fg">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        Partial figure: {names.join(", ")} could not be valued and {names.length === 1 ? "is" : "are"} left out of it.
      </span>
    </p>
  )
}
