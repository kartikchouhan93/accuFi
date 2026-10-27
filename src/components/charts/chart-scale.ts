// The geometry under the charts: where a mark goes, never what a figure says. A paise string is turned into a Number here,
// and only here, to place a mark; that number is never displayed, summed or compared as money. Every figure a chart shows
// as money is text formatted from the paise string itself (formatPaiseText), so a value beyond 2^53 paise is placed a
// hair off but always printed exactly. The one thing printed from these numbers is an axis tick, which is a round scale
// label chosen by niceDomain, not anybody's balance.

/** Where to place an amount given as paise text. Finite for any decimal string; 0 for anything that is not a number. */
export function paiseToNumber(text: string): number {
  const value = Number(text)
  return Number.isFinite(value) ? value : 0
}

const STEPS = [1, 2, 2.5, 5]
const MAX_TICKS = 7

/** Rounds away the binary noise of a multiplication (0.6000000000000001 becomes 0.6). */
const tidy = (value: number) => (value === 0 ? 0 : Number(value.toPrecision(12)))

/**
 * A value axis for the range min..max: always includes zero (a bar grows from it and a line is read against it), runs from
 * a whole number of steps below to a whole number above, and uses the smallest 1, 2, 2.5 or 5 × 10^k step that needs no
 * more than seven ticks. Three ticks at least, so even a single value has a scale to be read against. A range of nothing
 * (every value zero) is read as 0..1 so the axis still has a span.
 */
export function niceDomain(min: number, max: number): { min: number; max: number; ticks: number[] } {
  let lo = Math.min(0, min, max)
  let hi = Math.max(0, min, max)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0
    hi = 1
  }
  if (hi === lo) hi = lo + 1
  const span = hi - lo
  // Start one decade below the span: there, every step needs more than seven ticks, so the first that fits is the finest.
  let exponent = Math.floor(Math.log10(span)) - 1
  for (;;) {
    for (const mantissa of STEPS) {
      const step = mantissa * 10 ** exponent
      const first = Math.floor(lo / step)
      const last = Math.ceil(hi / step)
      if (last - first + 1 <= MAX_TICKS) {
        const ticks = Array.from({ length: last - first + 1 }, (_, i) => tidy((first + i) * step))
        if (ticks.length < 3) ticks.push(tidy((last + 1) * step))
        return { min: ticks[0], max: ticks[ticks.length - 1], ticks }
      }
    }
    exponent += 1
  }
}

/** A function from a value in `domain` to a position between `from` (at domain.min) and `to` (at domain.max). */
export function linearScale(domain: { min: number; max: number }, from: number, to: number): (value: number) => number {
  const span = domain.max - domain.min || 1
  return (value) => from + ((value - domain.min) / span) * (to - from)
}

const coordinate = (value: number) => String(Math.round(value * 100) / 100)

/** An SVG path through the points in order. A null lifts the pen, so a missing value is a gap, not a line drawn across it. */
export function linePath(points: ({ x: number; y: number } | null)[]): string {
  let path = ""
  let penDown = false
  for (const point of points) {
    if (point === null) {
      penDown = false
      continue
    }
    path += `${penDown ? "L" : "M"}${coordinate(point.x)},${coordinate(point.y)}`
    penDown = true
  }
  return path
}

const COMPACT = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1, useGrouping: true })

/**
 * An axis tick, given in paise, as compact rupees the Indian way: "₹500", "₹2.5K", "₹1L" (a lakh), "₹2Cr" (a crore). A tick
 * is a round number niceDomain chose, so the rounding here never misstates anybody's figure.
 */
export function formatTick(paise: number): string {
  const rupees = Math.abs(paise) / 100
  const sign = paise < 0 ? "-" : ""
  const [scaled, unit] = rupees >= 1e7 ? [rupees / 1e7, "Cr"] : rupees >= 1e5 ? [rupees / 1e5, "L"] : rupees >= 1e3 ? [rupees / 1e3, "K"] : [rupees, ""]
  return `${sign}₹${COMPACT.format(scaled)}${unit}`
}
