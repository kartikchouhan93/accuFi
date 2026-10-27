import type { BucketView } from "./report-view"
import { formatDay } from "./transaction-text"

// The words a report puts on its periods. A month the range covers in full is the month ("Jan 2026"); one the range cuts
// short says which of its days it covers ("1–15 Apr 2026"), so a short bar is never read as a quiet month. A one-day
// bucket is that day. Read from the date text itself, as formatDay is, so no timezone can move a day.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function periodLabel(bucket: Pick<BucketView, "from" | "to" | "partial">): string {
  const { from, to } = bucket
  if (from === to) return formatDay(from)
  const month = `${MONTHS[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`
  if (!bucket.partial) return month
  return `${Number(from.slice(8, 10))}–${Number(to.slice(8, 10))} ${month}`
}
