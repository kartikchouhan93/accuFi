import { AppShell } from "@/app/app-shell"
import { BudgetsSkeleton } from "@/components/ui/loading-screen"

export default function Loading() {
  return (
    <AppShell current="budgets">
      <BudgetsSkeleton />
    </AppShell>
  )
}
