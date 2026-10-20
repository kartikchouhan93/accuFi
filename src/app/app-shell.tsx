import Link from "next/link"
import { auth } from "@/server/auth"
import { signOutAction } from "./sign-out-action"

// The frame around a signed-in screen: wordmark, where you are, who you are, and a way out. Deliberately minimal. The
// dashboard and the later screens will add their own links here; today the ledger is the only destination, and sign
// out had no home anywhere before this.

export async function AppShell({ children }: { children: React.ReactNode }) {
  const email = (await auth())?.user?.email
  return (
    <div className="min-h-screen">
      <header className="border-b-4 border-double border-ink">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 sm:px-6">
          <Link href="/nodes" className="font-display text-xl font-bold tracking-tight">
            AccuFi
          </Link>
          <nav aria-label="Main" className="flex-1">
            <Link href="/nodes" aria-current="page" className="border-b-2 border-pen pb-0.5 font-medium">
              Ledger
            </Link>
          </nav>
          {email && <span className="hidden text-sm text-ink-soft sm:inline">{email}</span>}
          <form action={signOutAction}>
            <button type="submit" className="rounded-sm px-2 py-1 text-sm font-medium text-pen underline underline-offset-4">
              Sign out
            </button>
          </form>
        </div>
      </header>
      {children}
    </div>
  )
}
