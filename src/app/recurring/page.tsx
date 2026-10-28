import type { Metadata } from "next"
import { AppShell } from "@/app/app-shell"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { loadRecurringScreen } from "@/server/services/recurring-service"
import { RecurringWorkspace } from "./recurring-workspace"

export const metadata: Metadata = { title: "Recurring" }

// Reads the inbox, the rules and what was handled lately on the server and hands the client plain data: money as paise
// text, days as "YYYY-MM-DD". The page only reads; every change is a Server Action called from a button, which asks this
// page to be read again. The route guard sends anyone without a session to /login before this runs.
export default async function RecurringPage() {
  let screen: Awaited<ReturnType<typeof loadRecurringScreen>>
  try {
    screen = await loadRecurringScreen(await requireUserId())
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    throw error
  }
  return (
    <AppShell current="recurring">
      <RecurringWorkspace inbox={screen.inbox} rules={screen.rules} recent={screen.recent} />
    </AppShell>
  )
}
