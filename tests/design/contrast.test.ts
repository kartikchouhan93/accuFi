import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The palette is the one place a harmless-looking edit can make the app unreadable for someone: a lighter grey, a
// softer border. So the contrast of every pair that carries text or a control's edge is computed from globals.css
// itself, for both themes, and held to WCAG: 4.5:1 for text, 3:1 for the edge of a control, a focus ring, and a
// non-text mark. Change a colour and this fails with the pair and the ratio.

const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8")

function tokens(source: string): Record<string, string> {
  return Object.fromEntries([...source.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2].toLowerCase()]))
}

const light = tokens(css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "")
const dark = { ...light, ...tokens(css.match(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/)?.[1] ?? "") }

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const TEXT = 4.5
const EDGE = 3

// [foreground, background, minimum ratio, what it is]
const PAIRS: [string, string, number, string][] = [
  ["fg", "canvas", TEXT, "body text on the page"],
  ["fg", "panel", TEXT, "body text on a panel"],
  ["fg-soft", "canvas", TEXT, "secondary text on the page"],
  ["fg-soft", "panel", TEXT, "secondary text on a panel"],
  ["link", "panel", TEXT, "a link on a panel"],
  ["link", "canvas", TEXT, "a link on the page"],
  ["negative", "panel", TEXT, "an amount owed on a panel"],
  ["negative", "canvas", TEXT, "an amount owed on the page"],
  ["positive", "panel", TEXT, "a positive figure on a panel"],
  ["accent-fg", "accent", TEXT, "the label on the marigold button"],
  ["negative", "negative-wash", TEXT, "error text on its wash"],
  ["notice-fg", "notice-wash", TEXT, "notice text on its wash"],
  ["line-strong", "panel", EDGE, "an input's border on a panel"],
  ["line-strong", "canvas", EDGE, "an input's border on the page"],
  ["focus", "panel", EDGE, "the focus ring on a panel"],
  ["focus", "canvas", EDGE, "the focus ring on the page"],
  ["accent-edge", "panel", EDGE, "marigold used as a control's edge"],
]

describe.each([
  ["light", light],
  ["dark", dark],
] as const)("%s theme contrast", (_name, theme) => {
  it("defines every token the pairs use", () => {
    for (const [fg, bg] of PAIRS) {
      expect(theme[fg], `--${fg} is missing`).toBeDefined()
      expect(theme[bg], `--${bg} is missing`).toBeDefined()
    }
  })

  it.each(PAIRS)("%s on %s is at least %s:1 (%s)", (fg, bg, minimum) => {
    expect(contrast(theme[fg], theme[bg])).toBeGreaterThanOrEqual(minimum)
  })
})
