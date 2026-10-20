import { auth } from "@/server/auth"
import { AppNav, type Destination } from "./app-nav"
import { signOutAction } from "./sign-out-action"

// The frame around a signed-in screen: a rail of destinations down the side on a wide screen, a bar and drawer on a narrow
// one. The rail reserves 68px of the layout and opens over the page, so the page itself never shifts.

export type { Destination }

export async function AppShell({ children, current = "ledger" }: { children: React.ReactNode; current?: Destination }) {
  const email = (await auth())?.user?.email
  return (
    <div className="min-h-screen md:pl-[68px]">
      <AppNav current={current} email={email} signOut={signOutAction} />
      {children}
    </div>
  )
}
