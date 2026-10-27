import { rangeParams, type RangeChoice } from "../domain/periods"

// The reports, in the order their tabs are shown, and the one place a report's URL is put together: the range always in
// the query (so a report can be bookmarked, and the back button undoes a change of range), then the node a report is
// looking at, when it looks at one.

export type ReportSlug = "net-worth" | "cash-flow" | "spending" | "income" | "accounts" | "investments"

export const REPORTS: readonly { slug: ReportSlug; label: string }[] = [
  { slug: "net-worth", label: "Net worth" },
  { slug: "cash-flow", label: "Income vs expense" },
  { slug: "spending", label: "Spending" },
  { slug: "income", label: "Income" },
  { slug: "accounts", label: "Account history" },
  { slug: "investments", label: "Investment growth" },
]

export function isReportSlug(value: string): value is ReportSlug {
  return REPORTS.some((report) => report.slug === value)
}

/** `/reports/<slug>?range=…[&from=…&to=…][&node=…]`. A blank node is left out. */
export function reportHref(slug: ReportSlug, choice: RangeChoice, extra: { node?: string } = {}): string {
  const params = new URLSearchParams(Object.entries(rangeParams(choice)).filter((entry): entry is [string, string] => entry[1] !== undefined))
  if (extra.node) params.set("node", extra.node)
  return `/reports/${slug}?${params.toString()}`
}
