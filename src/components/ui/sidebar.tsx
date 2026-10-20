"use client"

import type { LucideIcon } from "lucide-react"
import { LogOut, Menu, X } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import Link from "next/link"
import { useEffect, useId, useRef, useState } from "react"
import { THEME_LABEL } from "@/lib/theme"
import { cn } from "@/lib/utils"
import { ThemeIcon, ThemeToggle, useTheme } from "./theme-toggle"

// Navigation as a slim rail that opens over the page. Adapted from Aceternity UI's sidebar, with the parts that would
// not survive a keyboard or a screen reader replaced:
//  - the rail opens on keyboard focus as well as on hover, and it opens OVER the page, so content never reflows when the
//    pointer crosses it;
//  - a collapsed label is faded and clipped, never `display: none`, so every link keeps its accessible name;
//  - the mobile menu is a real button with aria-expanded, and its drawer closes on Escape, keeps Tab inside itself and
//    hands focus back to the button that opened it.

export interface NavItem {
  key: string
  href: string
  label: string
  icon: LucideIcon
}

interface SidebarProps {
  items: NavItem[]
  current: string
  brand: React.ReactNode
  /** Who is signed in, shown at the foot of the rail. */
  email?: string | null
  /** A server action that ends the session. */
  signOut: () => Promise<void>
}

const RAIL = 68
const OPEN = 272

export function Sidebar(props: SidebarProps) {
  return (
    <>
      <DesktopRail {...props} />
      <MobileBar {...props} />
    </>
  )
}

function DesktopRail({ items, current, brand, email, signOut }: SidebarProps) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [overKey, setOverKey] = useState<string | null>(null) // the link under the pointer, for the sliding highlight
  const reduce = useReducedMotion()
  const open = hovered || focused
  return (
    // The outer element reserves the rail's width in the layout; the inner panel grows over the page.
    <aside className="fixed inset-y-0 left-0 z-40 hidden md:block" style={{ width: RAIL }}>
      <motion.div
        className="absolute inset-y-0 left-0 flex flex-col overflow-hidden border-r border-line bg-panel"
        initial={false}
        animate={{ width: open ? OPEN : RAIL }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 38 }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
        }}
      >
        <div className="flex h-16 shrink-0 items-center px-[14px]">{brand}</div>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1 px-3 pt-2" onPointerLeave={() => setOverKey(null)}>
          {items.map((item) => (
            <NavLink
              key={item.key}
              item={item}
              active={item.key === current}
              revealed={open}
              hovered={overKey === item.key}
              onHover={() => setOverKey(item.key)}
            />
          ))}
        </nav>
        <div className="flex flex-col gap-1 border-t border-line px-3 py-3">
          {email && <Account email={email} revealed={open} />}
          <ThemeRow revealed={open} />
          <SignOutButton signOut={signOut} revealed={open} />
        </div>
      </motion.div>
    </aside>
  )
}

function MobileBar({ items, current, brand, email, signOut }: SidebarProps) {
  const [open, setOpen] = useState(false)
  const reduce = useReducedMotion()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const drawerId = useId()

  useEffect(() => {
    if (!open) return
    const toggle = toggleRef.current
    closeRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false)
        return
      }
      if (event.key !== "Tab" || !drawerRef.current) return
      // Keep Tab inside the drawer: wrap from the last control to the first and back.
      const controls = drawerRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")
      if (controls.length === 0) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = previousOverflow
      toggle?.focus()
    }
  }, [open])

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-line bg-panel px-4 md:hidden">
      {brand}
      <div className="-mr-2 flex items-center">
        <ThemeToggle />
        <button
          ref={toggleRef}
          type="button"
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls={drawerId}
          onClick={() => setOpen(true)}
          className="grid size-10 place-items-center rounded-xl text-fg hover:bg-panel-raised"
        >
          <Menu aria-hidden className="size-5" />
        </button>
      </div>
      <AnimatePresence>
        {open && (
          <>
            <motion.button
              type="button"
              aria-label="Close menu"
              tabIndex={-1}
              className="fixed inset-0 z-50 bg-canvas/70 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.2 }}
              onClick={() => setOpen(false)}
            />
            <motion.div
              id={drawerId}
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Main menu"
              className="fixed inset-y-0 left-0 z-50 flex w-[min(20rem,86vw)] flex-col border-r border-line bg-panel"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 40 }}
            >
              <div className="flex h-14 items-center justify-between px-4">
                {brand}
                <button
                  ref={closeRef}
                  type="button"
                  aria-label="Close menu"
                  onClick={() => setOpen(false)}
                  className="-mr-2 grid size-10 place-items-center rounded-lg text-fg hover:bg-panel-raised"
                >
                  <X aria-hidden className="size-5" />
                </button>
              </div>
              <nav aria-label="Main" className="flex flex-1 flex-col gap-1 px-3 pt-2">
                {items.map((item) => (
                  <NavLink key={item.key} item={item} active={item.key === current} revealed onNavigate={() => setOpen(false)} />
                ))}
              </nav>
              <div className="flex flex-col gap-1 border-t border-line px-3 py-3">
                {email && <Account email={email} revealed />}
                <ThemeRow revealed />
                <SignOutButton signOut={signOut} revealed />
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </header>
  )
}

function NavLink({
  item,
  active,
  revealed,
  hovered = false,
  onHover,
  onNavigate,
}: {
  item: NavItem
  active: boolean
  revealed: boolean
  hovered?: boolean
  onHover?: () => void
  onNavigate?: () => void
}) {
  const Icon = item.icon
  const reduce = useReducedMotion()
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      onPointerEnter={onHover}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-11 items-center gap-3 overflow-hidden rounded-xl px-[13px] text-sm font-medium transition-colors",
        active ? "bg-panel-raised text-fg" : hovered ? "text-fg" : "text-fg-soft",
      )}
    >
      {/* One highlight shared by every link: it slides from the one the pointer left to the one it entered. */}
      {hovered && !active && (
        <motion.span
          layoutId="rail-hover"
          aria-hidden
          className="absolute inset-0 rounded-xl bg-panel-raised"
          transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 560, damping: 42 }}
        />
      )}
      {active && <span aria-hidden className="absolute inset-y-2.5 left-0 w-[3px] rounded-r-full bg-accent-edge" />}
      <Icon aria-hidden className="relative size-5 shrink-0" />
      <span className="relative">
        <Label revealed={revealed}>{item.label}</Label>
      </span>
    </Link>
  )
}

// Who is signed in. The initial is always on show, so the rail never leaves you unsure whose ledger this is; the address
// itself appears when the rail opens.
function Account({ email, revealed }: { email: string; revealed: boolean }) {
  return (
    <div className="flex h-11 items-center gap-3 overflow-hidden px-[11px]">
      <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full border border-line-strong bg-panel-raised text-xs font-semibold uppercase">
        {email.charAt(0)}
      </span>
      <p title={email} className={cn("truncate text-xs text-fg-soft transition-opacity duration-150", revealed ? "opacity-100" : "opacity-0")}>{email}</p>
    </div>
  )
}

// The theme, as a row in the same shape as a link: system, light or dark, one step per press.
function ThemeRow({ revealed }: { revealed: boolean }) {
  const { theme, cycle, label } = useTheme()
  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={label}
      title={label}
      className="flex h-11 w-full items-center gap-3 overflow-hidden rounded-xl px-[13px] text-sm font-medium text-fg-soft transition-colors hover:bg-panel-raised hover:text-fg"
    >
      <ThemeIcon theme={theme} />
      <Label revealed={revealed}>Theme: {THEME_LABEL[theme]}</Label>
    </button>
  )
}

function SignOutButton({ signOut, revealed }: { signOut: () => Promise<void>; revealed: boolean }) {
  return (
    <form action={signOut}>
      <button
        type="submit"
        className="flex h-11 w-full items-center gap-3 overflow-hidden rounded-xl px-[13px] text-sm font-medium text-fg-soft transition-colors hover:bg-panel-raised hover:text-fg"
      >
        <LogOut aria-hidden className="size-5 shrink-0" />
        <Label revealed={revealed}>Sign out</Label>
      </button>
    </form>
  )
}

// A collapsed label is faded and clipped by its container, never removed, so the link or button keeps its name.
function Label({ revealed, children }: { revealed: boolean; children: React.ReactNode }) {
  return <span className={cn("whitespace-nowrap transition-opacity duration-150", revealed ? "opacity-100" : "opacity-0")}>{children}</span>
}
