import { AppShell } from "@/app/app-shell"
import { ImportSkeleton } from "@/components/ui/loading-screen"

export default function Loading() {
  return (
    <AppShell current="import">
      <ImportSkeleton />
    </AppShell>
  )
}
