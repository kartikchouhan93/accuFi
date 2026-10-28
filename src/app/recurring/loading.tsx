import { AppShell } from "@/app/app-shell"
import { RecurringSkeleton } from "@/components/ui/loading-screen"

export default function Loading() {
  return (
    <AppShell current="recurring">
      <RecurringSkeleton />
    </AppShell>
  )
}
