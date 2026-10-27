"use client"

import { useId, useState } from "react"
import { formatPaiseText } from "@/lib/node-money"
import { cn } from "@/lib/utils"
import { ChartFrame, type ChartTableData } from "./chart-frame"
import { ChartReadout, Legend, nearestIndex, svgId, TONE_CLASS, useChartEntrance, useMeasuredWidth } from "./chart-interaction"
import { formatTick, linearScale, niceDomain, paiseToNumber } from "./chart-scale"

// Bars side by side for each position (income and spending for each month), growing from one zero line: up for a
// positive value, down for a negative one, so a month that lost money reads as below the line, not as a short bar.
// Values arrive as paise text and are converted to numbers only to be placed.
//
// Marks: bars at most 24px wide with a 2px gap between neighbours, rounded at the data end and square at the zero line.
// Income and spending are jade and rose, a pair that is hard to tell apart for someone with red-green colour blindness,
// so identity never rests on colour: the series always stand in the same order, a legend names them, and every series
// after the first carries a diagonal texture (thin lines of the panel colour across the bar) that the legend repeats.

interface Props {
  title: string
  summary: string
  labels: string[]
  series: { key: string; label: string; tone: "positive" | "negative" | "accent"; values: string[] }[]
  table: ChartTableData
}

const HEIGHT = 260
const TOP = 14
const BOTTOM = 30
const RIGHT = 8
const BAR = 24
const GAP = 2
const RADIUS = 4

/**
 * A bar from the zero line to `end`, rounded at `end` and square at the zero line. Written as "x,y" pairs only, so every
 * point it passes through can be read back. A bar too short to round is a plain rectangle.
 */
export function barPath(x: number, width: number, zero: number, end: number): string {
  const round = (v: number) => Math.round(v * 100) / 100
  const p = (px: number, py: number) => `${round(px)},${round(py)}`
  const height = Math.abs(end - zero)
  const r = Math.min(RADIUS, width / 2, height)
  const up = end < zero
  const toward = up ? 1 : -1 // from the data end back toward the zero line
  if (r <= 0.5) return `M${p(x, zero)}L${p(x, end)}L${p(x + width, end)}L${p(x + width, zero)}Z`
  return (
    `M${p(x, zero)}L${p(x, end + toward * r)}Q${p(x, end)} ${p(x + r, end)}` +
    `L${p(x + width - r, end)}Q${p(x + width, end)} ${p(x + width, end + toward * r)}L${p(x + width, zero)}Z`
  )
}

export function BarChart({ title, summary, labels, series, table }: Props) {
  const [box, width] = useMeasuredWidth<HTMLDivElement>(640)
  const entrance = useChartEntrance()
  const [active, setActive] = useState<number | null>(null)
  const hatch = svgId(useId())

  const numbers = series.flatMap((s) => s.values.map(paiseToNumber))
  const lo = numbers.length ? Math.min(...numbers) : 0
  const hi = numbers.length ? Math.max(...numbers) : 0
  const domain = niceDomain(lo, Math.max(hi, lo + 100)) // a span of at least a rupee, so every tick label is exact (formatTick)
  const tickLabels = domain.ticks.map(formatTick)
  const left = Math.max(...tickLabels.map((label) => label.length)) * 6.6 + 14
  const plotRight = width - RIGHT
  const y = linearScale(domain, HEIGHT - BOTTOM, TOP)
  const zeroY = y(0)
  const n = labels.length
  const band = n === 0 ? 0 : (plotRight - left) / n
  const count = Math.max(1, series.length)
  const barWidth = Math.max(2, Math.min(BAR, (band * 0.72 - GAP * (count - 1)) / count))
  const groupWidth = barWidth * count + GAP * (count - 1)
  const centres = labels.map((_, i) => left + band * i + band / 2)
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((plotRight - left) / 68))))
  const swatch = (index: number) => (index === 0 ? "block" : "hatched") as "block" | "hatched"
  const text = (value: string) => formatPaiseText(value)

  function onPointerMove(event: React.PointerEvent<SVGRectElement>) {
    const svg = event.currentTarget.ownerSVGElement
    if (!svg || n === 0) return
    const rect = svg.getBoundingClientRect()
    setActive(nearestIndex(centres, ((event.clientX - rect.left) * width) / (rect.width || width)))
  }

  return (
    <ChartFrame title={title} summary={summary} table={table}>
      <div ref={box} className="relative">
        <svg
          role="img"
          aria-label={`${title}. ${summary}`}
          width="100%"
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className={cn("block overflow-visible", entrance && "chart-enter")}
        >
          <defs>
            <pattern id={hatch} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="4" className="stroke-panel" strokeWidth="1.5" strokeOpacity={0.75} />
            </pattern>
          </defs>
          <g aria-hidden>
            {domain.ticks.map((tick, i) => (
              <g key={tick}>
                {tick !== 0 && <line x1={left} x2={plotRight} y1={y(tick)} y2={y(tick)} className="text-line" stroke="currentColor" strokeWidth={1} />}
                <text x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="figures fill-fg-soft text-[11px]">
                  {tickLabels[i]}
                </text>
              </g>
            ))}
            {labels.map((label, i) =>
              i % every === 0 ? (
                <text key={i} x={centres[i]} y={HEIGHT - 8} textAnchor="middle" className="fill-fg-soft text-[11px]">
                  {label}
                </text>
              ) : null,
            )}
          </g>
          {active !== null && (
            <rect aria-hidden x={left + band * active + 2} y={TOP} width={Math.max(0, band - 4)} height={HEIGHT - TOP - BOTTOM} rx={8} className="fill-fg-soft" fillOpacity={0.08} />
          )}
          {labels.map((label, i) =>
            series.map((s, k) => {
              const value = s.values[i] ?? "0"
              const x = centres[i] - groupWidth / 2 + k * (barWidth + GAP)
              const end = y(paiseToNumber(value))
              const d = barPath(x, barWidth, zeroY, end)
              const below = end > zeroY
              return (
                <g
                  key={`${s.key}-${i}`}
                  className={cn(TONE_CLASS[s.tone], below ? "chart-grow-down" : "chart-grow", active !== null && active !== i && "opacity-45")}
                  style={{ "--i": i } as React.CSSProperties}
                >
                  <path data-bar={value} d={d} fill="currentColor">
                    <title>{`${label}, ${s.label}: ${text(value)}`}</title>
                  </path>
                  {k > 0 && <path aria-hidden d={d} fill={`url(#${hatch})`} />}
                </g>
              )
            }),
          )}
          {/* The zero line, over the bars' square ends, so a bar is read from it. */}
          <line data-zero x1={left} x2={plotRight} y1={zeroY} y2={zeroY} className="text-line-strong" stroke="currentColor" strokeWidth={1} />
          <rect
            aria-hidden
            x={left}
            y={TOP}
            width={Math.max(0, plotRight - left)}
            height={HEIGHT - TOP - BOTTOM}
            fill="transparent"
            onPointerMove={onPointerMove}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
        {active !== null && (
          <ChartReadout
            x={centres[active]}
            width={width}
            label={labels[active]}
            rows={series.map((s, k) => ({ key: s.key, label: s.label, text: text(s.values[active] ?? "0"), tone: s.tone, swatch: swatch(k) }))}
          />
        )}
      </div>
      <Legend items={series.map((s, k) => ({ key: s.key, label: s.label, tone: s.tone, swatch: swatch(k) }))} />
    </ChartFrame>
  )
}
