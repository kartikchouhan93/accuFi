import { Clock } from "lucide-react"

// The words that go next to a net worth that counts an investment at a stale price (spec §7.3, EC-24): the figure is
// whole, but part of it rests on a price older than that investment's window, so it must not read as today's value.
// Shared by the dashboard and the ledger screen, beside the partial note.

const NAMED_AT_MOST = 3

function listed(names: readonly string[]): string {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

export function StaleNote({ names }: { names: readonly string[] }) {
  const text =
    names.length === 1
      ? `${names[0]} is valued at a price more than its stale window old.`
      : `${names.length <= NAMED_AT_MOST ? listed(names) : `${names.length} investments`} are valued at prices more than their stale window old.`
  return (
    <p role="note" className="mt-3 flex max-w-xl items-start gap-2.5 rounded-xl bg-notice-wash px-3.5 py-2.5 text-sm font-medium text-notice-fg">
      <Clock aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{text}</span>
    </p>
  )
}
