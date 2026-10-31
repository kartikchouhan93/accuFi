import type { Budget } from "@prisma/client"
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
