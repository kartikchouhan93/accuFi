import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { parseRangeChoice, ReportRangeError, type RangeChoice } from "@/domain/periods"
import { isReportSlug, REPORTS, type ReportSlug } from "@/lib/report-nav"
import type { RangeView } from "@/lib/report-view"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { NotFoundError } from "@/server/repositories/errors"
import {
  loadAccountHistory,
  loadCashFlow,
  loadInvestmentGrowth,
  loadNetWorthReport,
  loadRangeOptions,
  loadRanked,
} from "@/server/services/report-service"
import { AccountHistoryReport } from "../account-history-report"
import { CashFlowReport } from "../cash-flow-report"
import { InvestmentGrowthReport } from "../investment-growth-report"
import { NetWorthReport } from "../net-worth-report"
import { RankedReport } from "../ranked-report"
import { ReportShell } from "../report-shell"

// Every report screen: /reports/<slug>?range=…. The range is the URL's (so a report can be bookmarked and the back button
// undoes a change); the server reads it strictly. A range it cannot use, because it cannot read it or cannot report on it
// (a custom range that ends before it starts), is not an error page: the report shows the last 12 months instead and says
// why beside the range control, which is what the control's own wording promises. An unknown slug is not found, and so
// is a `node` (the account or investment a balance report looks at) that is not the user's or not of the report's kind:
// the same answer for both, and nothing of the node in it, so an id cannot be probed for.

type Params = Promise<{ report: string }>
type SearchParams = Promise<Record<string, string | string[] | undefined>>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { report } = await params
  const entry = REPORTS.find((candidate) => candidate.slug === report)
  return { title: entry ? `${entry.label} · Reports` : "Reports" }
}

/** One value per name: a repeated parameter (?range=a&range=b) is a hand-edited URL, and the first value is as good as any. */
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

const LAST_12: RangeChoice = { kind: "last12" }

/** The reports this page serves; any other is not found. */
const BUILT: ReadonlySet<ReportSlug> = new Set(["net-worth", "cash-flow", "spending", "income", "accounts", "investments"])

/** `load`, with a node that is not the user's (or not of the report's kind) answered as not found. */
async function orNotFound<T>(load: Promise<T>): Promise<T> {
  try {
    return await load
  } catch (error) {
    if (error instanceof NotFoundError) notFound()
    throw error
  }
}

/** The report a slug names, over `choice` (and `node`, for a report about one account or investment), and the range it was drawn over. */
async function loadReport(
  slug: ReportSlug,
  userId: string,
  choice: RangeChoice,
  node: string | undefined,
): Promise<{ range: RangeView; body: React.ReactNode }> {
  switch (slug) {
    case "net-worth": {
      const view = await loadNetWorthReport(userId, choice)
      return { range: view.range, body: <NetWorthReport view={view} /> }
    }
    case "accounts": {
      const view = await orNotFound(loadAccountHistory(userId, choice, node))
      return { range: view.range, body: <AccountHistoryReport view={view} choice={choice} /> }
    }
    case "investments": {
      const view = await orNotFound(loadInvestmentGrowth(userId, choice, node))
      return { range: view.range, body: <InvestmentGrowthReport view={view} choice={choice} /> }
    }
    case "cash-flow": {
      const view = await loadCashFlow(userId, choice)
      return { range: view.range, body: <CashFlowReport view={view} /> }
    }
    case "spending":
    case "income": {
      const view = await loadRanked(userId, choice, slug === "spending" ? "EXPENSE" : "INCOME_SOURCE")
      return { range: view.range, body: <RankedReport view={view} /> }
    }
    default:
      notFound()
  }
}

/**
 * The report over `choice`; when the loader finds it cannot report on that range (it reads, but ends before it starts),
 * the last 12 months instead, with the reason. `rangeError` is what reading the URL already found.
 */
async function loadWithFallback(slug: ReportSlug, userId: string, choice: RangeChoice, rangeError: string | null, node: string | undefined) {
  try {
    return { choice, rangeError, loaded: await loadReport(slug, userId, choice, node) }
  } catch (error) {
    if (!(error instanceof ReportRangeError) || choice.kind === "last12") throw error
    return { choice: LAST_12, rangeError: error.message, loaded: await loadReport(slug, userId, LAST_12, node) }
  }
}

export default async function ReportPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { report } = await params
  if (!isReportSlug(report) || !BUILT.has(report)) notFound()
  const query = await searchParams

  let choice: RangeChoice
  let rangeError: string | null = null
  try {
    choice = parseRangeChoice({ range: first(query.range), from: first(query.from), to: first(query.to) })
  } catch (error) {
    if (!(error instanceof ReportRangeError)) throw error
    choice = LAST_12
    rangeError = error.message
  }

  // A blank node is no node: the report's default (the oldest live account, or every investment).
  const node = first(query.node) || undefined

  let options: Awaited<ReturnType<typeof loadRangeOptions>>
  let shown: Awaited<ReturnType<typeof loadWithFallback>>
  try {
    const userId = await requireUserId()
    // The options do not depend on the range, so they are read once, beside the report.
    ;[options, shown] = await Promise.all([loadRangeOptions(userId), loadWithFallback(report, userId, choice, rangeError, node)])
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    throw error
  }

  return (
    <ReportShell current={report} range={shown.loaded.range} choice={shown.choice} options={options} rangeError={shown.rangeError}>
      {shown.loaded.body}
    </ReportShell>
  )
}
