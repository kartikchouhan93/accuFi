import { AppShell } from "@/app/app-shell"
import { TransactionsSkeleton } from "@/components/ui/loading-screen"

export default function Loading() {
  return (
    <AppShell current="transactions">
      <TransactionsSkeleton />
    </AppShell>
  )
}
