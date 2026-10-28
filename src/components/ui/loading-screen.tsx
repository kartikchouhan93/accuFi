import { Skeleton } from "@/components/ui/skeleton"

// What a screen looks like while its data is on the way: the same bones as the real thing, so the page does not jump when it
// arrives. A screen reader is told once, in words, that something is loading; the shapes themselves are hidden from it.
// Deliberately not a live region with role="status": the real screens use that role for their messages, and two at once would
// make "the" status ambiguous.

function Shell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <main aria-busy="true" className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-8">
      <p className="sr-only">Loading {label}</p>
      {children}
    </main>
  )
}

export function DashboardSkeleton() {
  return (
    <Shell label="the dashboard">
      <div className="flex items-center justify-between">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-11 w-48" />
      </div>
      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="space-y-10">
          <Skeleton className="h-72 rounded-3xl" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-28 rounded-2xl" />
            <Skeleton className="h-28 rounded-2xl" />
          </div>
        </div>
        <Skeleton className="h-[34rem] rounded-3xl" />
      </div>
    </Shell>
  )
}

export function LedgerSkeleton() {
  return (
    <Shell label="the ledger">
      <Skeleton className="h-10 w-40" />
      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Skeleton className="h-64 rounded-3xl" />
          <Skeleton className="h-48 rounded-3xl" />
          <Skeleton className="h-48 rounded-3xl" />
        </div>
        <Skeleton className="hidden h-[34rem] rounded-3xl lg:block" />
      </div>
    </Shell>
  )
}

export function TransactionsSkeleton() {
  return (
    <Shell label="your transactions">
      <Skeleton className="h-10 w-56" />
      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-3">
          <Skeleton className="h-16 rounded-2xl" />
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[4.5rem] rounded-2xl" />
          ))}
        </div>
        <Skeleton className="hidden h-[32rem] rounded-3xl lg:block" />
      </div>
    </Shell>
  )
}

export function InvestmentsSkeleton() {
  return (
    <Shell label="your investments">
      <div className="flex items-center justify-between">
        <Skeleton className="h-10 w-52" />
        <Skeleton className="h-11 w-40" />
      </div>
      <Skeleton className="mt-8 h-56 rounded-3xl" />
      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-52 rounded-3xl" />
        ))}
      </div>
    </Shell>
  )
}

export function RecurringSkeleton() {
  return (
    <Shell label="your recurring entries">
      <div className="flex items-center justify-between">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-11 w-36" />
      </div>
      <Skeleton className="mt-8 h-6 w-24" />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }, (_, i) => (
          <Skeleton key={i} className="h-44 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="mt-12 h-6 w-20" />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-40 rounded-2xl" />
      </div>
    </Shell>
  )
}

export function PricesSkeleton() {
  return (
    <Shell label="the price screen">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="mt-4 h-10 w-56" />
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:items-start">
        <Skeleton className="h-[26rem] rounded-3xl" />
        <Skeleton className="h-72 rounded-3xl" />
      </div>
    </Shell>
  )
}

export function ReportsSkeleton() {
  return (
    <Shell label="the report">
      <Skeleton className="h-10 w-40" />
      <div className="mt-6 flex gap-2 overflow-hidden">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-28 shrink-0 rounded-xl" />
        ))}
      </div>
      <Skeleton className="mt-4 h-32 rounded-3xl lg:h-24" />
      <Skeleton className="mt-8 h-[24rem] rounded-3xl" />
      <div className="mt-6 space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-14 rounded-2xl" />
        ))}
      </div>
    </Shell>
  )
}
