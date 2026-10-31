import { isoWeekday, type CalendarDate } from "../domain/calendar-date"
import { datesFromAnchor, normaliseSchedule, type Schedule } from "../domain/recurrence"

// The words a schedule is shown in, and the dates a form previews for it. Pure and importing only domain code, so the
// rule form (a client component) can use them as it is edited, and the server's rule view uses the same ones.

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]
// The shortest each month is, which is what decides whether a day of the month is ever clamped in it.
const SHORTEST_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** 1 is "1st", 2 "2nd", 3 "3rd", 11 "11th", 21 "21st". */
function ordinal(day: number): string {
  const teen = day % 100 >= 11 && day % 100 <= 13
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th")
  return `${day}${suffix}`
}

const every = (interval: number, unit: string, once: string) => (interval === 1 ? once : `Every ${interval} ${unit}s`)

function yearlyDay(schedule: Schedule): string {
  const month = Number(schedule.startDate.slice(5, 7)) - 1
  const day = schedule.dayOfMonth ?? Number(schedule.startDate.slice(8, 10))
  const name = MONTH_NAMES[month]
  if (month === 1 && day === 29) return `29 ${name} (28 ${name} in other years)`
  // A day the month sometimes does not have lands on its last day: say that, rather than a date that is not always real.
  if (day > SHORTEST_MONTH[month]) return `the last day of ${name}`
  return `${day} ${name}`
}

/**
 * The schedule in a line: "Monthly on the 31st, or the last day", "Every 2 weeks on Monday", "Every 3 months on the
 * 15th", "Yearly on 29 February (28 February in other years)", "Every day". The cadence only: the end date and the
 * occurrence limit are shown beside it.
 */
export function describeSchedule(input: Schedule): string {
  const schedule = normaliseSchedule(input)
  const { interval } = schedule
  switch (schedule.frequency) {
    case "DAILY":
      return interval === 1 ? "Every day" : `Every ${interval} days`
    case "WEEKLY":
      return `${every(interval, "week", "Weekly")} on ${WEEKDAYS[(schedule.dayOfWeek ?? isoWeekday(schedule.startDate)) - 1]}`
    case "YEARLY":
      return `${every(interval, "year", "Yearly")} on ${yearlyDay(schedule)}`
    default: {
      // Quarterly is every three months, said that way: the form's own choice of word does not change the dates.
      const months = (schedule.frequency === "QUARTERLY" ? 3 : 1) * interval
      const day = schedule.dayOfMonth ?? Number(schedule.startDate.slice(8, 10))
      const clamped = day >= 29 ? ", or the last day" : ""
      return `${every(months, "month", "Monthly")} on the ${ordinal(day)}${clamped}`
    }
  }
}

/**
 * The first `n` dates the schedule fires on, from its start date, as the form previews them. `count` is how many
 * occurrences the rule already has (0 for a new one), so a limit that is partly spent shows only what is left.
 * `lastDueOn` is the due day of the rule's last entry when it is being edited: a start date that is that day is not a new
 * date (see `datesFromAnchor`, which the save uses too).
 */
export function nextDatesPreview(schedule: Schedule, count: number, n: number, lastDueOn: CalendarDate | null = null): CalendarDate[] {
  if (!(n > 0)) return []
  return datesFromAnchor(normaliseSchedule(schedule), { count, lastDueOn, max: n })
}
