import { cache } from "react"
import { loadBudgetAttention } from "@/server/services/budget-report"

// How many budgets are near or over this month, for the dashboard's one line. `cache()` makes it one read per request.
//
// An ornament on a page that has its own job, like `pendingCount`: a count that cannot be read must not take the page
// down, so a failure is logged and the answer is 0 (no notice).
export const budgetAttention = cache(async (userId: string): Promise<number> => {
  try {
    const { near, over } = await loadBudgetAttention(userId)
    return near + over
  } catch (error) {
    console.error("[budgets] could not read the number of budgets needing attention; showing none", error)
    return 0
  }
})
