"use client"

import { useId, useState } from "react"
import { formatPaiseText } from "@/lib/node-money"
import { cn } from "@/lib/utils"
import { ChartFrame, type ChartTableData } from "./chart-frame"
import { ChartReadout, Legend, nearestIndex, svgId, TONE_CLASS, useChartEntrance, useMeasuredWidth, type ChartTone } from "./chart-interaction"
import { formatTick, linearScale, linePath, niceDomain, paiseToNumber } from "./chart-scale"

// A value over time, one line per series, on one axis that always includes zero. Values arrive as paise text and are
// converted to numbers only to be placed (chart-scale.ts). A null is a gap: the line stops and starts again, because a
// month that could not be valued is not a month worth ₹0. A hollow point is a figure that is not the whole picture (a net
// worth that leaves an unvalued investment out); it is drawn as an outline so it reads as different without colour.
//
// Marks: 2px lines with round ends, points of radius 4 with a 2px ring of the panel colour so they stay legible where they
// sit on a line, recessive hairline grid. Muted series are dashed, so two series never differ by colour alone, and two or
// more series always get a legend.

export interface LineSeries {
  key: string
  label: string
  tone: ChartTone
  /** Paise text per label; null where there is no value. */
  values: (string | null)[]
  /** Draw this point as an outline: a partial figure. */
  hollow?: boolean[]
  /** What each point says in its name and in the readout. Defaults to the amount, formatted from the paise text. */
  texts?: (string | null)[]
}

interface Props {
  title: string
  summary: string
  /** One per position along the axis: "Jan 2026". */
  labels: string[]
  series: LineSeries[]
  table: ChartTableData
}

const HEIGHT = 260
const TOP = 14
const BOTTOM = 30
const RIGHT = 14
const INSET = 18 // between the axis and the first and last positions, so their labels fit under them
const DENSE = 24 // past this many positions, only the points that need to be seen are drawn

export function pointText(series: LineSeries, index: number): string {
  const text = series.texts?.[index]
  if (text != null) return text
  const value = series.values[index]
  return value === null || value === undefined ? "No value" : formatPaiseText(value)
}

export function LineChart({ title, summary, labels, series, table }: Props) {
  const [box, width] = useMeasuredWidth<HTMLDivElement>(640)
  const entrance = useChartEntrance()
  const [active, setActive] = useState<number | null>(null)
  const gradient = svgId(useId())

  const numbers = series.flatMap((s) => s.values.flatMap((value) => (value === null ? [] : [paiseToNumber(value)])))
  const lo = numbers.length ? Math.min(...numbers) : 0
  const hi = numbers.length ? Math.max(...numbers) : 0
  const domain = niceDomain(lo, hi === lo ? lo + 100 : hi) // an all-flat chart still gets a scale of a rupee
  const tickLabels = domain.ticks.map(formatTick)
  const left = Math.max(...tickLabels.map((label) => label.length)) * 6.6 + 14
  const plotRight = width - RIGHT
  const y = linearScale(domain, HEIGHT - BOTTOM, TOP)
  const n = labels.length
  const xs = labels.map((_, i) => (n === 1 ? (left + plotRight) / 2 : left + INSET + (i * (plotRight - left - 2 * INSET)) / (n - 1)))
  const zeroY = y(0)

  // As many position labels as fit, evenly thinned.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((plotRight - left) / 68))))
  const single = series.length === 1

  const lines = series.map((s) => {
    const points = s.values.map((value, i) => (value === null ? null : { x: xs[i], y: y(paiseToNumber(value)) }))
    return { series: s, points, d: linePath(points) }
  })

  function onPointerMove(event: React.PointerEvent<SVGRectElement>) {
    const svg = event.currentTarget.ownerSVGElement
    if (!svg || n === 0) return
    const rect = svg.getBoundingClientRect()
    setActive(nearestIndex(xs, ((event.clientX - rect.left) * width) / (rect.width || width)))
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
          {single && (
            <defs>
              <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity={0.2} className={TONE_CLASS[series[0].tone]} />
                <stop offset="100%" stopColor="currentColor" stopOpacity={0} className={TONE_CLASS[series[0].tone]} />
              </linearGradient>
            </defs>
          )}
          <g aria-hidden>
            {domain.ticks.map((tick, i) => (
              <g key={tick}>
                <line x1={left} x2={plotRight} y1={y(tick)} y2={y(tick)} className={tick === 0 ? "text-line-strong" : "text-line"} stroke="currentColor" strokeWidth={1} />
                <text x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="figures fill-fg-soft text-[11px]">
                  {tickLabels[i]}
                </text>
              </g>
            ))}
            {labels.map((label, i) =>
              i % every === 0 ? (
                <text key={i} x={xs[i]} y={HEIGHT - 8} textAnchor="middle" className="fill-fg-soft text-[11px]">
                  {label}
                </text>
              ) : null,
            )}
          </g>
          {single &&
            segments(lines[0].points).map((segment, i) => (
              <path
                key={i}
                aria-hidden
                d={`${linePath(segment)}L${segment[segment.length - 1].x},${zeroY}L${segment[0].x},${zeroY}Z`}
                fill={`url(#${gradient})`}
                className="chart-fade"
              />
            ))}
          {lines.map(({ series: s, d }) =>
            d === "" ? null : (
              <path
                key={s.key}
                data-series={s.key}
                d={d}
                pathLength={s.tone === "muted" ? undefined : 1}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={s.tone === "muted" ? "5 4" : undefined}
                className={cn(TONE_CLASS[s.tone], s.tone === "muted" ? "chart-fade" : "chart-draw")}
              >
                <title>{s.label}</title>
              </path>
            ),
          )}
          {active !== null && (
            <line aria-hidden x1={xs[active]} x2={xs[active]} y1={TOP} y2={HEIGHT - BOTTOM} className="text-line-strong" stroke="currentColor" strokeWidth={1} />
          )}
          {lines.map(({ series: s, points }) =>
            points.map((point, i) => {
              if (point === null) return null
              const hollow = s.hollow?.[i] === true
              const isolated = points[i - 1] == null && points[i + 1] == null
              if (n > DENSE && !hollow && !isolated && i !== n - 1 && i !== active) return null
              const r = i === active ? 5.5 : 4
              const name = `${labels[i]}, ${s.label}: ${pointText(s, i)}`
              return (
                <g key={`${s.key}-${i}`} className={cn(TONE_CLASS[s.tone], "chart-fade")} style={{ "--i": i } as React.CSSProperties}>
                  {hollow ? (
                    <>
                      <circle aria-hidden cx={point.x} cy={point.y} r={r + 2} className="fill-panel" />
                      <circle data-point="hollow" cx={point.x} cy={point.y} r={r} fill="none" stroke="currentColor" strokeWidth={2}>
                        <title>{name}</title>
                      </circle>
                    </>
                  ) : (
                    <circle data-point="solid" cx={point.x} cy={point.y} r={r} fill="currentColor" className="stroke-panel" strokeWidth={2}>
                      <title>{name}</title>
                    </circle>
                  )}
                </g>
              )
            }),
          )}
          {/* The pointer's target: the whole plot, so a reader aims at a month, not at a 2px line. */}
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
            x={xs[active]}
            width={width}
            label={labels[active]}
            rows={series.map((s) => ({ key: s.key, label: s.label, text: pointText(s, active), tone: s.tone, swatch: s.tone === "muted" ? "dashed" : "line" }))}
          />
        )}
      </div>
      {series.length > 1 && <Legend items={series.map((s) => ({ key: s.key, label: s.label, tone: s.tone, swatch: s.tone === "muted" ? "dashed" : "line" }))} />}
    </ChartFrame>
  )
}

/** The runs of consecutive points between gaps. */
function segments(points: ({ x: number; y: number } | null)[]): { x: number; y: number }[][] {
  const runs: { x: number; y: number }[][] = []
  let run: { x: number; y: number }[] = []
  for (const point of points) {
    if (point === null) {
      if (run.length) runs.push(run)
      run = []
    } else run.push(point)
  }
  if (run.length) runs.push(run)
  return runs
}
