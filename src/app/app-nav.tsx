"use client"

import { ArrowLeftRight, BookOpen, ChartColumn, LayoutDashboard, Repeat, TrendingUp } from "lucide-react"
import Link from "next/link"
import { Sidebar, type NavItem } from "@/components/ui/sidebar"

// The destinations, with their icons. This file is a client component because an icon is a component, and a component
// cannot be passed as a prop from a Server Component; the shell hands over only strings and the sign-out action.

export type Destination = "dashboard" | "ledger" | "transactions" | "investments" | "recurring" | "reports"

const ITEMS: NavItem[] = [
  { key: "dashboard", href: "/", label: "Dashboard", icon: LayoutDashboard },
  { key: "ledger", href: "/nodes", label: "Ledger", icon: BookOpen },
  { key: "transactions", href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { key: "investments", href: "/investments", label: "Investments", icon: TrendingUp },
  { key: "recurring", href: "/recurring", label: "Recurring", icon: Repeat },
  { key: "reports", href: "/reports", label: "Reports", icon: ChartColumn },
]

function Brand() {
  return (
    <Link href="/" aria-label="AccuFi, home" className="flex items-center gap-3 rounded-lg">
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent font-display text-lg font-bold text-accent-fg">
        A
      </span>
      <span className="whitespace-nowrap font-display text-lg font-semibold tracking-tight">AccuFi</span>
    </Link>
  )
}

/** `pending` is the number of recurring entries waiting for the user: the badge on Recurring, and part of its name. */
export function AppNav({
  current,
  email,
  signOut,
  pending = 0,
}: {
  current: Destination
  email?: string | null
  signOut: () => Promise<void>
  pending?: number
}) {
  const items = ITEMS.map((item) => (item.key === "recurring" ? { ...item, badge: pending } : item))
  return <Sidebar items={items} current={current} brand={<Brand />} email={email} signOut={signOut} />
}
