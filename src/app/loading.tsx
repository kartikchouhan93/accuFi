import { AppShell } from "@/app/app-shell"
import { DashboardSkeleton } from "@/components/ui/loading-screen"

// Shown at "/" while the dashboard is read. The shell is kept, so the rail does not vanish and come back.
export default function Loading() {
  return (
    <AppShell current="dashboard">
      <DashboardSkeleton />
    </AppShell>
  )
}
