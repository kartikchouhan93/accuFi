import type { BalanceText, Tone } from "@/lib/node-money"

// A figure as the ledger prints it: tabular digits that never wrap, in the ink of its tone (red for what is owed or
// lost, the bookkeeper's convention), with an optional word after it ("owed", "received"). Shared by every screen that
// shows money, so a figure reads the same on all of them.

export const TONE_CLASS: Record<Tone, string> = {
  positive: "text-ink",
  negative: "text-red",
  neutral: "text-ink",
  muted: "text-ink-soft",
}

export function Amount({ text, className = "" }: { text: BalanceText; className?: string }) {
  return (
    <span className={`figures whitespace-nowrap ${TONE_CLASS[text.tone]} ${className}`}>
      {text.amount}
      {text.qualifier && (
        <>
          {" "}
          <span className="text-sm font-normal text-ink-soft">{text.qualifier}</span>
        </>
      )}
    </span>
  )
}
