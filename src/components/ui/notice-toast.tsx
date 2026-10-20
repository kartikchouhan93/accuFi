"use client"

import { CircleCheck, TriangleAlert } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import type { RefObject } from "react"
import { cn } from "@/lib/utils"

// The one message area of a screen: what just happened, or what to look at. It springs up from the bottom edge and sinks
// away when dismissed. It stays until dismissed, deliberately: a message that vanishes on a timer is a message a slow reader
// or a screen-reader user can miss. The container is a polite live region and can take focus, so a row that deletes itself
// (and with it the keyboard's place) can hand focus here.

export interface ToastNotice {
  tone: "success" | "warning"
  text: string
}

// Each message gets its own identity, so the same words twice in a row still animate in again.
const identity = new WeakMap<object, number>()
let issued = 0
function idOf(notice: object): number {
  let id = identity.get(notice)
  if (id === undefined) {
    id = issued++
    identity.set(notice, id)
  }
  return id
}

export function NoticeToast({ notice, onDismiss, statusRef }: { notice: ToastNotice | null; onDismiss: () => void; statusRef: RefObject<HTMLDivElement | null> }) {
  const reduce = useReducedMotion()
  const warning = notice?.tone === "warning"
  const Icon = warning ? TriangleAlert : CircleCheck
  return (
    <div ref={statusRef} role="status" tabIndex={-1} className="pointer-events-none fixed inset-x-4 bottom-4 z-30 mx-auto max-w-xl outline-offset-4 empty:hidden">
      <AnimatePresence>
        {notice && (
          <motion.div
            key={idOf(notice)}
            initial={reduce ? false : { opacity: 0, y: 28, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, y: 16, scale: 0.97 }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 480, damping: 36 }}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-2xl border bg-panel px-4 py-3 shadow-[0_18px_50px_-18px_rgb(0_0_0/0.55)]",
              warning ? "border-notice-fg/60" : "border-line-strong",
            )}
          >
            <Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", warning ? "text-notice-fg" : "text-positive")} />
            <p className="flex-1">{notice.text}</p>
            <button type="button" onClick={onDismiss} className="rounded-md text-sm font-medium text-link underline underline-offset-4">
              Dismiss
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
