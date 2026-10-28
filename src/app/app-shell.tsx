import { PageBackdrop } from "@/components/ui/page-backdrop"
import { auth } from "@/server/auth"
import { countPendingFor } from "@/server/services/recurring-service"
import { AppNav, type Destination } from "./app-nav"
import { signOutAction } from "./sign-out-action"

// The frame around a signed-in screen: a rail of destinations down the side on a wide screen, a bar and drawer on a narrow
// one. The rail reserves 68px of the layout and opens over the page, so the page itself never shifts.

export type { Destination }

export async function AppShell({ children, current = "ledger" }: { children: React.ReactNode; current?: Destination }) {
  const session = await auth()
  const email = session?.user?.email
  // The badge on Recurring. A session without a user id has no count; the page's own guard deals with it.
  const userId = session?.user?.id
  const pending = typeof userId === "string" && userId !== "" ? await countPendingFor(userId) : 0
  return (
    <div className="min-h-screen md:pl-[68px]">
      <PageBackdrop />
      <AppNav current={current} email={email} signOut={signOutAction} pending={pending} />
      {children}
    </div>
  )
}
