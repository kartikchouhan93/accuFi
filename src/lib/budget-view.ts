import type { Budget } from "@prisma/client"
import type { BudgetStatus } from "../domain/budgets"
import { fromDbDate } from "../domain/calendar-date"
import { serialisePaise } from "./serialise"

// A budget as it crosses to the browser: not the Prisma row (paise are a bigint, which breaks JSON.stringify, and the
// months are Dates) but paise as decimal text and months as "YYYY-MM-01" strings. `userId` and the audit timestamps are
// left off. Pure: no reads, no server imports.

export interface BudgetSettingsView {
  id: string
  nodeId: string
  nodeName: string
  /** Paise, as a decimal string. */
  amountPaise: string
  /** The first day of the first month it applies to. */
  startMonth: string
  /** The first day of the last month it applies to; null while it has no end. */
  endMonth: string | null
  rollover: boolean
}

export function toBudgetSettingsView(budget: Budget, nodeName: string): BudgetSettingsView {
  return {
    id: budget.id,
    nodeId: budget.nodeId,
    nodeName,
    amountPaise: serialisePaise(budget.amountPaise),
    startMonth: fromDbDate(budget.startMonth),
    endMonth: budget.endMonth === null ? null : fromDbDate(budget.endMonth),
    rollover: budget.rollover,
  }
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "May 2026" for "2026-05-01" (or any day of it). */
export function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
}

/** "May 2026 to Sep 2026", or "May 2026 onwards" for a span with no end. */
export function spanLabel(startMonth: string, endMonth: string | null): string {
  return endMonth === null ? `${monthLabel(startMonth)} onwards` : `${monthLabel(startMonth)} to ${monthLabel(endMonth)}`
}

// -- The budgets screen ---------------------------------------------------------------------------------------------------
// What `loadBudgetsScreen` hands the page. Every amount is paise as decimal text and every month a "YYYY-MM-01" string, so
// the whole screen serialises with JSON.stringify (no bigint) and can cross to a client component as is.

/** One budgeted month of a ledger, as a row of its "Past months" table. */
export interface BudgetHistoryRow {
  /** "YYYY-MM-01". */
  month: string
  usedPaise: string
  availablePaise: string
  status: BudgetStatus
  /** The Transactions screen filtered to exactly the entries this month's `usedPaise` is made of. */
  drillHref: string
}

/** One budget for the selected month: the figures, what they count, and where they lead. */
export interface BudgetCard {
  budgetId: string
  nodeId: string
  name: string
  archived: boolean
  /** The names of the sub-ledgers counted along with the ledger itself (archived ones included), in the user's order. */
  countedNames: string[]
  /** The cap for the selected month. */
  amountPaise: string
  carryPaise: string
  availablePaise: string
  /** Can be negative: a month of net refunds. */
  usedPaise: string
  /** Negative when over. */
  remainingPaise: string
  /** Tenths of a percent of what is available (852 is 85.2%); null when there is no percent to show. */
  percentTenths: string | null
  status: BudgetStatus
  /** Where the month ends at the current pace; only for the current month, once there is enough data. */
  projectionPaise: string | null
  overAtPace: boolean
  rollover: boolean
  /** The first day of the first month of the span the selected month is in. */
  startMonth: string
  endMonth: string | null
  drillHref: string
  /** Every budgeted month of the ledger through the current one, newest first. */
  history: BudgetHistoryRow[]
}

export interface BudgetsScreen {
  /** The user's today, "YYYY-MM-DD". */
  today: string
  /** The month shown, "YYYY-MM-01": the one asked for, clamped to `months`. */
  month: string
  /** Every month from the earliest budget's start to the current one, oldest first; empty with no budget yet. */
  months: string[]
  /** One per budget covering `month`, most strained first. */
  cards: BudgetCard[]
  /** The user has no budget at all. */
  empty: boolean
}
