import { AppShell } from "@/app/app-shell"
import { LedgerSkeleton } from "@/components/ui/loading-screen"

export default function Loading() {
  return (
    <AppShell current="ledger">
      <LedgerSkeleton />
    </AppShell>
  )
}
