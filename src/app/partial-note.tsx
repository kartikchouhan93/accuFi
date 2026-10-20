// The words that go next to a net worth that is not the whole figure: an investment that could not be valued is left out
// of the total, and a lower number must not pass for the whole picture. Shared by the dashboard and the ledger screen.
export function PartialNote({ names }: { names: readonly string[] }) {
  return (
    <p role="note" className="mt-3 max-w-xl bg-notice-wash px-3 py-2 font-medium text-notice-fg">
      Partial figure: {names.join(", ")} could not be valued and {names.length === 1 ? "is" : "are"} left out of it.
    </p>
  )
}
