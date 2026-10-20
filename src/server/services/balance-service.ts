import { buildDashboard, type DashboardView } from "@/lib/dashboard-view"
import { compareDates, fromDbDate, type CalendarDate } from "@/domain/calendar-date"
import { findTransactions, sumBalances } from "@/server/repositories/transaction-repository"
import { todayFor } from "@/server/services/clock"
import { listAllNodes } from "@/server/services/node-service"

/** How many of the newest transactions the dashboard lists. */
const RECENT_COUNT = 10

/**
 * The front page's data. The figures are today's (`asOf`, by default today in the user's own timezone): a transaction
 * dated after it is not in them (EC-10). They are summed twice, once bounded at that day and once with no bound, and
 * `projected` is the unbounded net worth, shown only when the two differ, so a rent payment entered in advance does not
 * lower this month's figure until its day comes but is still visible. Archived nodes are in every total and not in the
 * list. Safe to hand to a client component: no bigint, no Date.
 */
export async function getDashboard(userId: string, asOf?: CalendarDate): Promise<DashboardView> {
  const today = asOf ?? (await todayFor(userId))
  const [nodes, current, all, recent, furthest] = await Promise.all([
    listAllNodes(userId),
    sumBalances(userId, today),
    sumBalances(userId),
    findTransactions(userId, { to: today }, undefined, RECENT_COUNT),
    // Newest first, so the first row on or after today is the furthest-dated one: later than today means a projection.
    findTransactions(userId, { from: today }, undefined, 1),
  ])
  const latest = furthest.items[0]
  const latestDate = latest === undefined ? null : fromDbDate(latest.occurredAt)
  return buildDashboard({
    nodes,
    current,
    all,
    recent: recent.items,
    latestDate: latestDate !== null && compareDates(latestDate, today) > 0 ? latestDate : null,
  })
}
