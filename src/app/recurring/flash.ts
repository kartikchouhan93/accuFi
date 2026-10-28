import { useEffect } from "react"
import type { ToastNotice } from "@/components/ui/notice-toast"

// A message that has to survive a navigation: the rule form saves and goes to /recurring, which then says what was done.
// Kept in sessionStorage for the one hop and read once (the next read finds nothing), so a reload does not say it again.
// Storage can be missing or throw (a private window, blocked site data); then the message is simply not shown, which
// loses nothing: the screen it lands on is the proof.

const KEY = "accufi:recurring-flash"

export type Flash = Pick<Extract<ToastNotice, { lines: string[] }>, "tone" | "lines">

export function leaveFlash(flash: Flash): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(flash))
  } catch {
    // nothing to do: see above
  }
}

/** The message left for this screen, if any, removed as it is read. */
export function takeFlash(): Flash | null {
  try {
    const stored = sessionStorage.getItem(KEY)
    if (stored === null) return null
    sessionStorage.removeItem(KEY)
    const flash: unknown = JSON.parse(stored)
    if (
      typeof flash === "object" && flash !== null &&
      "tone" in flash && (flash.tone === "success" || flash.tone === "warning") &&
      "lines" in flash && Array.isArray(flash.lines) && flash.lines.every((line) => typeof line === "string")
    ) {
      return { tone: flash.tone, lines: flash.lines }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Says what was left for this screen, once, as it opens. The read is a frame later, not in the effect itself: the storage is
 * read in the browser only (the server render agrees with the first client render), and a cleanup that cancels it keeps the
 * strict-mode double mount from taking the message twice. `show` must be stable (a state setter).
 */
export function useFlash(show: (flash: Flash) => void): void {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const flash = takeFlash()
      if (flash) show(flash)
    })
    return () => cancelAnimationFrame(frame)
  }, [show])
}
