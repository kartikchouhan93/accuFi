import type { CalendarDate } from "@/domain/calendar-date"
import { todayIn } from "@/domain/calendar-date"
import { NotFoundError } from "@/server/repositories/errors"
import { findUserTimezone } from "@/server/repositories/user-repository"

/**
 * Today's date in the user's own timezone: what "current" means for their balances (a transaction dated after it is
 * projected, EC-10) and what a new entry is dated. The one place a service turns a user into a day, so the ledger, the
 * transaction screen and the dashboard cannot disagree about when today is. Throws NotFoundError for an unknown user.
 */
export async function todayFor(userId: string): Promise<CalendarDate> {
  const timezone = await findUserTimezone(userId)
  if (timezone === null) throw new NotFoundError("user")
  return todayIn(timezone)
}
