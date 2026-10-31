import type { Metadata } from "next"
import { AppShell } from "@/app/app-shell"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { loadBudgetsScreen } from "@/server/services/budget-report"
import { BudgetsWorkspace } from "./budgets-workspace"
import { monthFromParam } from "./month-param"

export const metadata: Metadata = { title: "Budgets" }

// Reads the month's budgets on the server and hands the client plain data: money as paise text, months as "YYYY-MM-01". The
// month comes from `?month=YYYY-MM`; anything else shows the current month (a bad link is never an error), and the service
// keeps a month outside the first budget's start and today inside it. The page only reads; a delete is a Server Action
// called from a card, which asks this page to be read again. The route guard sends anyone without a session to /login
// before this runs.
export default async function BudgetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const month = monthFromParam((await searchParams).month)
  let screen: Awaited<ReturnType<typeof loadBudgetsScreen>>
  try {
    screen = await loadBudgetsScreen(await requireUserId(), month)
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    throw error
  }
  return (
    <AppShell current="budgets">
      <BudgetsWorkspace screen={screen} />
    </AppShell>
  )
}
