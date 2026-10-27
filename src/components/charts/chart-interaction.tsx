"use client"

import { useReducedMotion } from "motion/react"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { cn } from "@/lib/utils"

// The parts of a chart that need the browser: how wide it is, whether it may move, and the readout that follows the pointer.
// None of it is needed to read a chart: the marks carry their names, and the table under every chart has every figure.

const noSubscription = () => () => {}

/**
 * Whether the chart plays its entrance. The entrance is CSS (globals.css, `.chart-enter`), so it plays from the server's
 * markup without waiting for a script, and the stylesheet only runs it under `prefers-reduced-motion: no-preference`. Once
 * hydrated, a chart for someone who asked for less motion drops the class altogether. The first client render agrees with
 * the server (it cannot know the preference), so there is no hydration mismatch; the class goes on the render after.
 */
export function useChartEntrance(): boolean {
  const reduce = useReducedMotion()
  const hydrated = useSyncExternalStore(noSubscription, () => true, () => false)
  return !(hydrated && reduce)
}

/**
 * The width the chart is drawn at, in CSS pixels, so its text is drawn at the size it is read at rather than scaled with
 * the picture. The server draws at `fallback`; the browser measures and redraws.
 */
export function useMeasuredWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      const measured = Math.round(entry.contentRect.width)
      if (measured > 0) setWidth(Math.max(260, measured))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

/** The index of the position nearest the pointer, for a chart whose positions are at `xs` (in the SVG's own units). */
export function nearestIndex(xs: readonly number[], x: number): number {
  let best = 0
  for (let i = 1; i < xs.length; i += 1) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i
  return best
}

export type ChartTone = "accent" | "positive" | "negative" | "muted"

/** The token a series is drawn in, as a text colour: every mark is drawn in `currentColor`. */
export const TONE_CLASS: Record<ChartTone, string> = {
  accent: "text-accent",
  positive: "text-positive",
  negative: "text-negative",
  muted: "text-fg-soft",
}

export interface ReadoutRow {
  key: string
  label: string
  text: string
  tone: ChartTone
  /** How the row's key is drawn: a short line for a line chart, a block for bars. */
  swatch: "line" | "dashed" | "block" | "hatched"
}

/**
 * The readout beside the pointer: the position's label, then each series with its value leading. Hidden from assistive
 * technology, which has the marks' names and the table instead; this is for the eye only.
 */
export function ChartReadout({ x, width, label, rows }: { x: number; width: number; label: string; rows: ReadoutRow[] }) {
  // Keep the card on the chart: to the right of the pointer, or to its left past the middle.
  const flip = x > width / 2
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-2 z-10 min-w-36 rounded-xl border border-line bg-panel/90 px-3 py-2 text-xs shadow-[0_12px_32px_-12px_rgb(0_0_0/0.35)] backdrop-blur-md",
      )}
      style={flip ? { right: width - x + 12 } : { left: x + 12 }}
    >
      <p className="font-medium text-fg-soft">{label}</p>
      <ul className="mt-1 space-y-0.5">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2 whitespace-nowrap">
            <Swatch tone={row.tone} kind={row.swatch} />
            <span className="figures font-semibold text-fg">{row.text}</span>
            <span className="text-fg-soft">{row.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A series' key, as drawn in a legend and in the readout. */
export function Swatch({ tone, kind }: { tone: ChartTone; kind: ReadoutRow["swatch"] }) {
  if (kind === "line" || kind === "dashed") {
    return (
      <svg aria-hidden width="16" height="8" className={cn("shrink-0", TONE_CLASS[tone])}>
        <line x1="1" y1="4" x2="15" y2="4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={kind === "dashed" ? "4 3" : undefined} />
      </svg>
    )
  }
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2.5 shrink-0 rounded-[3px] bg-current", TONE_CLASS[tone])}
      style={kind === "hatched" ? { backgroundImage: HATCH_CSS } : undefined}
    />
  )
}

/** The texture on a second bar series, in CSS for a swatch (the SVG bars use a <pattern> of the same lines). */
export const HATCH_CSS = "repeating-linear-gradient(135deg, transparent 0 2px, var(--panel) 2px 3.5px)"

export function Legend({ items }: { items: { key: string; label: string; tone: ChartTone; swatch: ReadoutRow["swatch"] }[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-fg-soft">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-2">
          <Swatch tone={item.tone} kind={item.swatch} />
          {item.label}
        </li>
      ))}
    </ul>
  )
}

/** A safe fragment id from React's useId, which may contain characters that do not survive in `url(#…)`. */
export const svgId = (id: string) => `c${id.replace(/[^a-zA-Z0-9_-]/g, "")}`
