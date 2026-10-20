import Link from "next/link"
import { auth } from "@/server/auth"
import { signOutAction } from "./sign-out-action"

// The frame around a signed-in screen: wordmark, where you are, who you are, and a way out. Deliberately minimal: a
// later screen adds its own entry to DESTINATIONS.

const DESTINATIONS: { key: Destination; href: string; label: string }[] = [
  { key: "dashboard", href: "/", label: "Dashboard" },
  { key: "ledger", href: "/nodes", label: "Ledger" },
  { key: "transactions", href: "/transactions", label: "Transactions" },
]

export type Destination = "dashboard" | "ledger" | "transactions"

export async function AppShell({ children, current = "ledger" }: { children: React.ReactNode; current?: Destination }) {
  const email = (await auth())?.user?.email
  return (
    <div className="min-h-screen">
      <header className="border-b-4 border-double border-fg">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 sm:px-6">
          <Link href="/" className="font-display text-xl font-bold tracking-tight">
            AccuFi
          </Link>
          <nav aria-label="Main" className="flex flex-1 gap-5">
            {DESTINATIONS.map(({ key, href, label }) => (
              <Link
                key={key}
                href={href}
                aria-current={key === current ? "page" : undefined}
                className={`pb-0.5 font-medium ${key === current ? "border-b-2 border-accent" : "text-fg-soft hover:text-fg"}`}
              >
                {label}
              </Link>
            ))}
          </nav>
          {email && <span className="hidden text-sm text-fg-soft sm:inline">{email}</span>}
          <form action={signOutAction}>
            <button type="submit" className="rounded-sm px-2 py-1 text-sm font-medium text-accent underline underline-offset-4">
              Sign out
            </button>
          </form>
        </div>
      </header>
      {children}
    </div>
  )
}
