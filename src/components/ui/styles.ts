import { cn } from "@/lib/utils"

// The two controls every screen shares, as class strings so they apply equally to a <button>, an <a> and a Next <Link>.
// One primary style on purpose: marigold is the colour of an action, so a screen with one marigold button has one
// obvious thing to do.

type Variant = "primary" | "secondary" | "ghost"
type Size = "md" | "sm"

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium transition-[background-color,border-color,transform] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-55"

const VARIANTS: Record<Variant, string> = {
  primary: "border border-accent-edge bg-accent text-accent-fg hover:brightness-105",
  secondary: "border border-line-strong bg-panel text-fg hover:bg-panel-raised",
  ghost: "border border-transparent text-fg-soft hover:bg-panel-raised hover:text-fg",
}

const SIZES: Record<Size, string> = {
  md: "h-11 px-5 text-[15px]",
  sm: "h-9 px-3.5 text-sm",
}

export function buttonClass({ variant = "primary", size = "md", className }: { variant?: Variant; size?: Size; className?: string } = {}) {
  return cn(BASE, VARIANTS[variant], SIZES[size], className)
}

/** A text field or select: tall enough to tap, a border that clears 3:1, and the same radius as a button. */
export const inputClass =
  "h-11 w-full rounded-xl border border-line-strong bg-canvas px-3.5 text-fg placeholder:text-fg-soft disabled:opacity-60"
