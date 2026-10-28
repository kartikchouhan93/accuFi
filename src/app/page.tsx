import { Plus, Wallet } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { AccountSummary, summaryKinds } from "@/app/account-summary"
import { AppShell } from "@/app/app-shell"
import { NetWorthCard } from "@/app/net-worth-card"
import { PendingNotice } from "@/app/pending-notice"
import { RecentTransactions } from "@/app/recent-transactions"
import { ThisMonth } from "@/app/this-month"
import { buttonClass } from "@/components/ui/styles"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { getDashboard } from "@/server/services/balance-service"
import { countPendingFor } from "@/server/services/recurring-service"

export const metadata: Metadata = { title: "Dashboard" }

// The front page: where the money stands today, and how it is spread. Read on the server, so every figure is the
// server's (archived accounts included in each total) and reaches the markup as text. The route guard sends anyone
// without a session to /login before this runs.
export default async function DashboardPage() {
  let dashboard: Awaited<ReturnType<typeof getDashboard>>
  let pending: number
  try {
    const userId = await requireUserId()
    ;[dashboard, pending] = await Promise.all([getDashboard(userId), countPendingFor(userId)])
  } catch (error) {
    redirectIfUnauthenticated(error)
    throw error
  }
  return (
    <AppShell current="dashboard">
      <main className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">Dashboard</h1>
          {!dashboard.isEmpty && (
            <Link href="/transactions" className={buttonClass()}>
              <Plus aria-hidden className="size-4" />
              Record a transaction
            </Link>
          )}
        </div>
        {pending > 0 && <PendingNotice count={pending} />}
        {dashboard.isEmpty ? (
          <section aria-labelledby="start-heading" className="surface mt-8 max-w-xl rounded-3xl p-8">
            <span aria-hidden className="grid size-12 place-items-center rounded-2xl bg-panel-raised text-accent-edge">
              <Wallet className="size-6" />
            </span>
            <h2 id="start-heading" className="mt-5 font-display text-2xl font-semibold tracking-tight">
              Start with your first account
            </h2>
            <p className="mt-2 text-fg-soft">
              Your net worth is what you hold less what you owe, so it begins with somewhere you keep money: a bank account, a wallet, a credit
              card. Add one, with what is in it today, and this page fills in as you record what comes and goes.
            </p>
            <Link href="/nodes" className={buttonClass({ className: "mt-6" })}>
              Add your first account
            </Link>
          </section>
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] lg:items-start">
            <div className="space-y-10">
              <NetWorthCard netWorth={dashboard.netWorth} projected={dashboard.projected} trend={dashboard.trend} sections={summaryKinds(dashboard)} />
              <ThisMonth thisMonth={dashboard.thisMonth} />
              <AccountSummary accounts={dashboard.accounts} kindTotals={dashboard.kindTotals} />
              <p className="text-sm text-fg-soft">
                Add, rename or archive accounts in the{" "}
                <Link href="/nodes" className="rounded-md font-medium text-link underline underline-offset-4">
                  ledger
                </Link>
                .
              </p>
            </div>
            <div className="lg:sticky lg:top-8">
              <RecentTransactions recent={dashboard.recent} />
            </div>
          </div>
        )}
      </main>
    </AppShell>
  )
}
