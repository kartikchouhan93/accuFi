import { describeGain } from "@/lib/investment-text"
import { cn } from "@/lib/utils"

// An unrealised gain as the investments screen prints it: signed, with its percentage, in jade for a gain and in the
// negative ink for a loss (colour here means what the money is doing, as everywhere in the app), unsigned and muted when
// there is neither. The sign is in the text, so the colour is never the only thing that says which it is.
const TONE: Record<ReturnType<typeof describeGain>["tone"], string> = {
  positive: "text-positive",
  negative: "text-negative",
  neutral: "text-fg",
  muted: "text-fg-soft",
}

export function Gain({ paise, points, className }: { paise: string; points: number | null; className?: string }) {
  const gain = describeGain(paise, points)
  return <span className={cn("figures whitespace-nowrap", TONE[gain.tone], className)}>{gain.amount}</span>
}
