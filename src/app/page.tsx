import type { Metadata } from "next"
import Link from "next/link"
import { AccountSummary } from "@/app/account-summary"
import { AppShell } from "@/app/app-shell"
import { NetWorthCard } from "@/app/net-worth-card"
import { RecentTransactions } from "@/app/recent-transactions"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { getDashboard } from "@/server/services/balance-service"

export const metadata: Metadata = { title: "Dashboard" }

// The front page: where the money stands today, and how it is spread. Read on the server, so every figure is the
// server's (archived accounts included in each total) and reaches the markup as text. The route guard sends anyone
// without a session to /login before this runs.
export default async function DashboardPage() {
  let dashboard: Awaited<ReturnType<typeof getDashboard>>
  try {
    dashboard = await getDashboard(await requireUserId())
  } catch (error) {
    redirectIfUnauthenticated(error)
    throw error
  }
  return (
    <AppShell current="dashboard">
      <main className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-6">
        <h1 className="font-display text-4xl font-bold tracking-tight">Dashboard</h1>
        {dashboard.isEmpty ? (
          <section aria-labelledby="start-heading" className="mt-8 max-w-xl bg-panel p-6">
            <h2 id="start-heading" className="font-display text-2xl font-semibold">
              Start with your first account
            </h2>
            <p className="mt-2 text-fg-soft">
              Your net worth is what you hold less what you owe, so it begins with somewhere you keep money: a bank account, a wallet, a credit
              card. Add one, with what is in it today, and this page fills in as you record what comes and goes.
            </p>
            <Link href="/nodes" className="mt-4 inline-block rounded-sm bg-accent px-4 py-2 font-medium text-accent-fg">
              Add your first account
            </Link>
          </section>
        ) : (
          <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
            <div className="space-y-10">
              <NetWorthCard netWorth={dashboard.netWorth} projected={dashboard.projected} />
              <RecentTransactions recent={dashboard.recent} />
            </div>
            <div>
              <AccountSummary accounts={dashboard.accounts} kindTotals={dashboard.kindTotals} />
              <p className="mt-6 text-sm text-fg-soft">
                Add, rename or archive accounts in the{" "}
                <Link href="/nodes" className="font-medium text-accent underline underline-offset-4">
                  ledger
                </Link>
                .
              </p>
            </div>
          </div>
        )}
      </main>
    </AppShell>
  )
}
