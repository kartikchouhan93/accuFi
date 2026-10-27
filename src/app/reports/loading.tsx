import { AppShell } from "@/app/app-shell"
import { ReportsSkeleton } from "@/components/ui/loading-screen"

export default function Loading() {
  return (
    <AppShell current="reports">
      <ReportsSkeleton />
    </AppShell>
  )
}
