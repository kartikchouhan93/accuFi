import { useEffect } from "react"
import type { ToastNotice } from "@/components/ui/notice-toast"

// A message that has to survive a navigation: a form saves and goes to its list screen, which then says what was done. Kept
// in sessionStorage for the one hop and read once (the next read finds nothing), so a reload does not say it again. Storage
// can be missing or throw (a private window, blocked site data); then the message is simply not shown, which loses nothing:
// the screen it lands on is the proof.
//
// Each screen has its own channel, a storage key of its own, so a message left for one screen can never be shown by another
// (a rule saved, then Budgets opened, must not announce the rule there). See recurring/flash.ts and budgets/flash.ts.

export type Flash = Pick<Extract<ToastNotice, { lines: string[] }>, "tone" | "lines">

export function flashChannel(key: string) {
  function leaveFlash(flash: Flash): void {
    try {
      sessionStorage.setItem(key, JSON.stringify(flash))
    } catch {
      // nothing to do: see above
    }
  }

  /** The message left on this channel, if any, removed as it is read. */
  function takeFlash(): Flash | null {
    try {
      const stored = sessionStorage.getItem(key)
      if (stored === null) return null
      sessionStorage.removeItem(key)
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
   * Says what was left on this channel, once, as the screen opens. The read is a frame later, not in the effect itself: the
   * storage is read in the browser only (the server render agrees with the first client render), and a cleanup that cancels
   * it keeps the strict-mode double mount from taking the message twice. `show` must be stable (a state setter).
   */
  function useFlash(show: (flash: Flash) => void): void {
    useEffect(() => {
      const frame = requestAnimationFrame(() => {
        const flash = takeFlash()
        if (flash) show(flash)
      })
      return () => cancelAnimationFrame(frame)
    }, [show])
  }

  return { leaveFlash, takeFlash, useFlash }
}
