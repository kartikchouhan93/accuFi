import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { BarChart } from "@/components/charts/bar-chart"
import type { ChartTableData } from "@/components/charts/chart-frame"
import { LineChart } from "@/components/charts/line-chart"
import { RankedBars } from "@/components/charts/ranked-bars"

// The charts as markup, from values given as the server sends them: paise text. What is checked is what a reader gets
// without the picture (the table, the names of the marks) and the geometry that would mislead if it were wrong (a gap where a
// value is missing, a negative bar below the line).

const visibleText = (html: string) => html.replace(/<[^>]+>/g, "")
const clean = (html: string) => {
  expect(html).not.toMatch(/NaN/)
  expect(html).not.toMatch(/undefined/)
  expect(html).not.toMatch(/Infinity/)
}

const lineTable: ChartTableData = {
  columns: ["Month", "Net worth"],
  rows: [
    { label: "Jan 2026", cells: ["₹82,000.00"] },
    { label: "Feb 2026", cells: ["Not valued"] },
    { label: "Mar 2026", cells: ["₹1,87,000.00"] },
    { label: "Apr 2026", cells: ["₹1,23,45,67,89,01,23,45,67,89,012.34"] },
  ],
}

const line = (hollow?: boolean[]) =>
  renderToStaticMarkup(
    createElement(LineChart, {
      title: "Net worth over time",
      summary: "Net worth rose from ₹82,000.00 in January to ₹1,23,45,67,89,01,23,45,67,89,012.34 in April.",
      labels: ["Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026"],
      series: [{ key: "total", label: "Net worth", tone: "accent", values: ["8200000", null, "18700000", "123456789012345678901234"], hollow }],
      table: lineTable,
    }),
  )

// The `d` of each series line (data-series marks the line itself, not the area under it or a grid line).
const seriesPaths = (html: string) => [...html.matchAll(/<path[^>]*data-series="[^"]*"[^>]*\sd="([^"]*)"/g)].map((m) => m[1])

describe("LineChart", () => {
  it("renders an image with a name, and a table with the same figures as passed", () => {
    const html = line()
    clean(html)
    expect(html).toMatch(/role="img"/)
    expect(html).toMatch(/aria-label="[^"]*Net worth rose from/)
    expect(html).toContain("<table")
    expect(html).toContain("View as table")
    const text = visibleText(html)
    for (const row of lineTable.rows) {
      expect(text).toContain(row.label)
      for (const cell of row.cells) expect(text).toContain(cell)
    }
  })

  it("breaks the line where a value is missing, rather than joining across it or dropping to zero", () => {
    const paths = seriesPaths(line())
    expect(paths).toHaveLength(1)
    expect(paths[0].match(/M/g)).toHaveLength(2)
  })

  it("gives every point a name", () => {
    const html = line()
    const points = [...html.matchAll(/<circle[^>]*data-point[^>]*>(.*?)<\/circle>/g)]
    expect(points).toHaveLength(3) // the missing February has no point
    for (const point of points) expect(point[1]).toMatch(/<title>[^<]+<\/title>/)
    expect(html).toMatch(/<title>Jan 2026, Net worth: ₹82,000.00<\/title>/)
  })

  it("draws a hollow point as an outline", () => {
    const html = line([false, false, true, false])
    clean(html)
    const hollow = [...html.matchAll(/<circle[^>]*data-point="hollow"[^>]*>/g)].map((m) => m[0])
    expect(hollow).toHaveLength(1)
    expect(hollow[0]).toMatch(/fill="none"/)
    const solid = [...html.matchAll(/<circle[^>]*data-point="solid"[^>]*>/g)].map((m) => m[0])
    expect(solid).toHaveLength(2)
    for (const point of solid) expect(point).not.toMatch(/fill="none"/)
  })

  it("names the series in a legend when there is more than one", () => {
    const html = renderToStaticMarkup(
      createElement(LineChart, {
        title: "Investment growth",
        summary: "Value against what was put in.",
        labels: ["Jan 2026", "Feb 2026"],
        series: [
          { key: "invested", label: "Invested", tone: "muted", values: ["1000000", "1000000"] },
          { key: "value", label: "Value", tone: "accent", values: [null, "1170000"] },
        ],
        table: { columns: ["Month", "Invested", "Value"], rows: [] },
      }),
    )
    clean(html)
    expect(seriesPaths(html)).toHaveLength(2)
    expect(visibleText(html)).toMatch(/Invested.*Value/)
  })
})

describe("BarChart", () => {
  const html = renderToStaticMarkup(
    createElement(BarChart, {
      title: "Income vs expense",
      summary: "Income and spending by month.",
      labels: ["Jan 2026", "Feb 2026"],
      series: [
        { key: "income", label: "Income", tone: "positive", values: ["5000000", "4000000"] },
        { key: "saved", label: "Net saved", tone: "negative", values: ["3000000", "-1500000"] },
      ],
      table: {
        columns: ["Period", "Income", "Net saved"],
        rows: [
          { label: "Jan 2026", cells: ["₹50,000.00", "₹30,000.00"] },
          { label: "Feb 2026", cells: ["₹40,000.00", "-₹15,000.00"] },
        ],
      },
    }),
  )

  it("renders an image with a table and named bars", () => {
    clean(html)
    expect(html).toMatch(/role="img"/)
    expect(visibleText(html)).toContain("-₹15,000.00")
    const bars = [...html.matchAll(/<path[^>]*data-bar[^>]*>(.*?)<\/path>/g)]
    expect(bars).toHaveLength(4)
    for (const bar of bars) expect(bar[1]).toMatch(/<title>[^<]+<\/title>/)
    expect(html).toContain("<title>Feb 2026, Net saved: -₹15,000.00</title>")
  })

  it("draws a negative value below the zero line and a positive one above it", () => {
    const zero = Number(/<line[^>]*data-zero[^>]*y1="([-\d.]+)"/.exec(html)?.[1])
    expect(Number.isFinite(zero)).toBe(true)
    const ys = (d: string) => [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2]))
    const bar = (value: string) => ys(new RegExp(`<path[^>]*data-bar="${value}"[^>]*\\sd="([^"]*)"`).exec(html)?.[1] ?? "")
    const negative = bar("-1500000")
    expect(negative.length).toBeGreaterThan(0)
    for (const y of negative) expect(y).toBeGreaterThanOrEqual(zero)
    expect(Math.max(...negative)).toBeGreaterThan(zero)
    const positive = bar("5000000")
    for (const y of positive) expect(y).toBeLessThanOrEqual(zero)
  })
})

describe("RankedBars", () => {
  const ranked = (shareTenths: number | null) =>
    renderToStaticMarkup(createElement(RankedBars, { rows: [{ key: "rent", label: "Rent", amount: "₹1,20,000.00", shareTenths }] }))

  it("prints a share in tenths of a percent", () => {
    const html = ranked(852)
    clean(html)
    const text = visibleText(html)
    expect(text).toContain("Rent")
    expect(text).toContain("₹1,20,000.00")
    expect(text).toContain("85.2%")
  })

  it("prints whole and tiny shares exactly", () => {
    expect(visibleText(ranked(1000))).toContain("100.0%")
    expect(visibleText(ranked(5))).toContain("0.5%")
  })

  it("prints no percentage when there is no share", () => {
    const html = ranked(null)
    clean(html)
    expect(visibleText(html)).not.toContain("%")
    expect(visibleText(html)).toContain("₹1,20,000.00")
  })
})
