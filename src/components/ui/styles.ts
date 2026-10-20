import { cn } from "@/lib/utils"

// The two controls every screen shares, as class strings so they apply equally to a <button>, an <a> and a Next <Link>.
// One primary style on purpose: the accent blue is the colour of an action, so a screen with one blue button has one
// obvious thing to do. The primary button carries a light sweep across it on hover; the sweep is a pseudo-element, so it adds
// nothing to the markup and nothing to the accessibility tree.

type Variant = "primary" | "secondary" | "ghost" | "danger"
type Size = "md" | "sm"

const BASE =
  "relative inline-flex items-center justify-center gap-2 overflow-hidden whitespace-nowrap rounded-xl font-medium transition-[background-color,border-color,color,transform,box-shadow] duration-200 active:translate-y-px disabled:pointer-events-none disabled:opacity-55"

const SWEEP =
  "before:pointer-events-none before:absolute before:inset-y-0 before:-left-1/2 before:w-1/3 before:-skew-x-12 before:-translate-x-full before:bg-gradient-to-r before:from-transparent before:via-white/30 before:to-transparent before:transition-transform before:duration-700 before:content-[''] hover:before:translate-x-[420%]"

const VARIANTS: Record<Variant, string> = {
  primary: `border border-accent-edge bg-accent text-accent-fg shadow-[0_1px_0_rgb(255_255_255/0.25)_inset] hover:shadow-[0_6px_22px_-8px_var(--accent)] ${SWEEP}`,
  secondary: "border border-line-strong bg-panel text-fg hover:border-fg-soft hover:bg-panel-raised",
  ghost: "border border-transparent text-fg-soft hover:bg-panel-raised hover:text-fg",
  danger: "border border-negative bg-negative-wash text-negative hover:bg-negative hover:text-canvas",
}

const SIZES: Record<Size, string> = {
  md: "h-11 px-5 text-[15px]",
  sm: "h-9 px-3.5 text-sm",
}

export function buttonClass({ variant = "primary", size = "md", className }: { variant?: Variant; size?: Size; className?: string } = {}) {
  return cn(BASE, VARIANTS[variant], SIZES[size], className)
}

/**
 * A text field or select: tall enough to tap, a border that clears 3:1, the same radius as a button. The border brightens on
 * hover and a soft ring of the accent blooms on focus, in addition to (never instead of) the global focus outline.
 */
export const inputClass =
  "h-11 w-full rounded-xl border border-line-strong bg-canvas px-3.5 text-fg placeholder:text-fg-soft transition-[border-color,box-shadow] duration-200 hover:border-fg-soft focus-visible:border-accent-edge focus-visible:ring-4 focus-visible:ring-accent/20 disabled:opacity-60 aria-[invalid=true]:border-negative aria-[invalid=true]:ring-negative/20"
