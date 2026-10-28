import { buildDashboard, type DashboardView } from "@/lib/dashboard-view"
import { compareDates, fromDbDate, type CalendarDate } from "@/domain/calendar-date"
import { findTransactions, sumBalances } from "@/server/repositories/transaction-repository"
import { todayFor } from "@/server/services/clock"
import { readValuationInputs, valuationStatesFrom } from "@/server/services/investment-service"
import { listAllNodes } from "@/server/services/node-service"
import { loadCashFlow, loadNetWorthReport } from "@/server/services/report-service"

/** How many of the newest transactions the dashboard lists. */
const RECENT_COUNT = 10

/**
 * The front page's data. The figures are today's (`asOf`, by default today in the user's own timezone): a transaction
 * dated after it is not in them (EC-10). They are summed twice, once bounded at that day and once with no bound, and
 * `projected` is the unbounded net worth, shown only when the two differ, so a rent payment entered in advance does not
 * lower this month's figure until its day comes but is still visible. An investment held by lots counts at its value:
 * today's figure at what it holds today, the projection at what it will hold on the projection's day, both at today's
 * prices (call 6, as amended), so a purchase or sale dated ahead moves money between the account and the holding rather
 * than out of net worth or into it twice. One not valued is named and left out (EC-23); one valued at a stale price is
 * named too (EC-24). Archived nodes are in every total and not in the list. Safe to hand to a client component: no
 * bigint, no Date.
 *
 * Beside those figures, and never instead of them: this month's income, spending and savings from the cash flow report,
 * and the last twelve month-ends from the net worth report, whose last point is today's figure. The reports are the only
 * arithmetic for both; they are handed the valuation inputs read here, so prices and lots are read once. The core
 * figures above follow `asOf`; the strip and the trend always describe the user's real current month and last twelve
 * month-ends (the report loaders take no date), so a past or future `asOf` never moves them, nor makes them throw.
 */
export async function getDashboard(userId: string, asOf?: CalendarDate): Promise<DashboardView> {
  const realToday = await todayFor(userId)
  const today = asOf ?? realToday
  const month = { kind: "month", year: Number(realToday.slice(0, 4)), month: Number(realToday.slice(5, 7)) } as const
  const inputs = readValuationInputs(userId)
  const [nodes, current, all, recent, furthest, held, flow, netWorthReport] = await Promise.all([
    listAllNodes(userId),
    sumBalances(userId, today),
    sumBalances(userId),
    findTransactions(userId, { to: today }, undefined, RECENT_COUNT),
    // Newest first, so the first row on or after today is the furthest-dated one: later than today means a projection.
    findTransactions(userId, { from: today }, undefined, 1),
    inputs,
    loadCashFlow(userId, month),
    inputs.then((read) => loadNetWorthReport(userId, { kind: "last12" }, { inputs: read })),
  ])
  const latest = furthest.items[0]
  const furthestDate = latest === undefined ? null : fromDbDate(latest.occurredAt)
  const latestDate = furthestDate !== null && compareDates(furthestDate, today) > 0 ? furthestDate : null
  const { valuations, unvalued, priced } = valuationStatesFrom(held, today)
  return buildDashboard({
    nodes,
    current,
    all,
    recent: recent.items,
    latestDate,
    valuations,
    unvalued,
    priced,
    projectedValuations: latestDate === null ? undefined : valuationStatesFrom(held, latestDate, { priceAsOf: today }).valuations,
    month: { choice: month, flow },
    netWorthReport,
  })
}
