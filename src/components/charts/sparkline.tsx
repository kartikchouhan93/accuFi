import { cn } from "@/lib/utils"
import { linearScale, linePath, paiseToNumber } from "./chart-scale"

// A figure's recent shape, small enough to sit beside the figure: one line, no axis, no grid, drawn on the server. It
// stretches to the width it is given (the drawing is scaled, the strokes are not, so the line stays 2px at any width) and
// reads between its lowest and highest value, because its job is the shape; the exact figures are in its label and on
// the report it opens. Values arrive as paise text and become numbers only to be placed (chart-scale.ts).
//
// Marks: the last point, where the figure stands now, is a solid dot. A hollow point is a figure that is not the whole
// picture, drawn as a ring so it reads as different without colour. A single value is a dot and no line: there is no
// history to draw, and none is made up. The entrance is CSS (globals.css, `.chart-enter`) and only plays for someone who
// has not asked for less motion.

interface Props {
  /** Paise text, oldest first. */
  values: readonly string[]
  /** Draw this point as a ring: a partial figure. */
  hollow?: readonly boolean[]
  /** What the line shows, in words, with the figures: the line's accessible name. */
  label: string
  className?: string
}

const WIDTH = 300
const HEIGHT = 56
const PAD = 7 // room for a dot at the top, bottom and ends

const coordinate = (value: number) => Math.round(value * 100) / 100

export function Sparkline({ values, hollow = [], label, className }: Props) {
  const numbers = values.map(paiseToNumber)
  // Scaled lowest to highest by design, not from zero: the line shows shape, and the label carries the exact first and last figures.
  const lo = numbers.length ? Math.min(...numbers) : 0
  const hi = numbers.length ? Math.max(...numbers) : 0
  const scale = linearScale({ min: lo, max: hi }, HEIGHT - PAD, PAD)
  const y = (value: number) => (hi === lo ? HEIGHT / 2 : scale(value)) // a flat line sits in the middle
  const n = values.length
  const x = (i: number) => (n === 1 ? WIDTH / 2 : PAD + (i * (WIDTH - 2 * PAD)) / (n - 1))
  const points = numbers.map((value, i) => ({ x: x(i), y: y(value) }))
  const line = n > 1 ? linePath(points) : ""
  // A dot is a zero-length stroke with a round cap: drawn in screen pixels, it stays round however the drawing is stretched.
  const dot = (point: { x: number; y: number }) => `M${coordinate(point.x)},${coordinate(point.y)}h0`

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      width="100%"
      height={HEIGHT}
      className={cn("chart-enter block overflow-visible text-accent", className)}
    >
      {line && (
        <g aria-hidden className="chart-fade">
          <path d={`${line}L${coordinate(points[n - 1].x)},${HEIGHT}L${coordinate(points[0].x)},${HEIGHT}Z`} fill="currentColor" fillOpacity={0.08} />
          <path
            data-sparkline-line=""
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      )}
      {points.map((point, i) => {
        const ring = hollow[i] === true
        if (!ring && i !== n - 1) return null
        return (
          <g key={i} aria-hidden className="chart-fade" style={{ "--i": i } as React.CSSProperties}>
            {/* A collar of the card's colour under every dot, so it stays legible where it sits on the line. */}
            <path d={dot(point)} className="text-panel" stroke="currentColor" strokeWidth={12} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            <path data-point={ring ? "hollow" : "solid"} d={dot(point)} stroke="currentColor" strokeWidth={8} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            {ring && <path d={dot(point)} className="text-panel" stroke="currentColor" strokeWidth={4} strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
          </g>
        )
      })}
    </svg>
  )
}
