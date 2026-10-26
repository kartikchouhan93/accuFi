import { AppShell } from "@/app/app-shell"
import { PricesSkeleton } from "@/components/ui/loading-screen"

export default function Loading() {
  return (
    <AppShell current="investments">
      <PricesSkeleton />
    </AppShell>
  )
}
