import { cache } from "react"
import { countPendingFor } from "@/server/services/recurring-service"

// The number of recurring entries waiting, for the badge on the Recurring nav item (every signed-in page, through the
// shell) and the notice on the dashboard. `cache()` makes the shell and the page one read per request instead of two.
//
// Both are ornaments on a page that has its own job: a count that cannot be read must not take the page down, so a
// failure is logged and the answer is 0 (no badge, no notice). The failure is cached for the request too, so it is
// logged once and not retried by the second caller.
export const pendingCount = cache(async (userId: string): Promise<number> => {
  try {
    return await countPendingFor(userId)
  } catch (error) {
    console.error("[recurring] could not read the number of waiting entries; showing none", error)
    return 0
  }
})
