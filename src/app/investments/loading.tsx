import { AppShell } from "@/app/app-shell"
import { InvestmentsSkeleton } from "@/components/ui/loading-screen"

export default function Loading() {
  return (
    <AppShell current="investments">
      <InvestmentsSkeleton />
    </AppShell>
  )
}
