"use client"

import { Monitor, Moon, Sun } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useSyncExternalStore } from "react"
import { nextTheme, parseTheme, THEME_LABEL, THEME_STORAGE_KEY, type Theme } from "@/lib/theme"
import { cn } from "@/lib/utils"

// Three states, one button: follow the system, or light, or dark. The choice is kept in localStorage and applied as
// data-theme on <html> (the inline script in the layout re-applies it before first paint on the next visit). Read through
// useSyncExternalStore, so the server and the first client render agree on "system" and the real value follows without a
// hydration mismatch, and every toggle on the page, and every other tab, stays in step.

const listeners = new Set<() => void>()
let remembered: Theme | null = null // used only when storage is blocked, so the toggle still works for this visit

function read(): Theme {
  if (remembered) return remembered
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return "system"
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener("storage", listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", listener)
  }
}

function choose(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
    remembered = null
  } catch {
    remembered = theme
  }
  const root = document.documentElement
  if (theme === "system") delete root.dataset.theme
  else root.dataset.theme = theme
  listeners.forEach((listener) => listener())
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, read, () => "system" as Theme)
  const next = nextTheme(theme)
  return {
    theme,
    next,
    cycle: () => choose(next),
    label: `Theme: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[next]}`,
  }
}

const ICON: Record<Theme, typeof Sun> = { system: Monitor, light: Sun, dark: Moon }

/** The current theme's icon, which turns over to the next one's when it changes. */
export function ThemeIcon({ theme, className }: { theme: Theme; className?: string }) {
  const reduce = useReducedMotion()
  const Icon = ICON[theme]
  return (
    <span className={cn("relative grid shrink-0 place-items-center", className)}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={theme}
          initial={reduce ? false : { opacity: 0, rotate: -80, scale: 0.6 }}
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={reduce ? undefined : { opacity: 0, rotate: 80, scale: 0.6 }}
          transition={{ duration: reduce ? 0 : 0.18 }}
          className="grid place-items-center"
        >
          <Icon aria-hidden className="size-5" />
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

/** A standalone icon button, for places with no room for a label (the sign-in screens, the phone's top bar). */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, cycle, label } = useTheme()
  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={label}
      title={label}
      className={cn("grid size-10 place-items-center rounded-xl text-fg-soft transition-colors hover:bg-panel-raised hover:text-fg", className)}
    >
      <ThemeIcon theme={theme} />
    </button>
  )
}
