"use client"

import { AnimatePresence, motion, useReducedMotion } from "motion/react"

// A panel that opens and closes by growing and shrinking to its content, rather than snapping. The content is not in the
// document while closed, which is what lets a control's aria-controls point at it only while it exists. `overflow` is hidden
// only during the movement, so a focus outline on an edge control is not clipped once the panel is at rest.

export function Collapse({ open, id, children, className }: { open: boolean; id?: string; children: React.ReactNode; className?: string }) {
  const reduce = useReducedMotion()
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          id={id}
          className={className}
          initial={reduce ? false : { height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
          exit={reduce ? undefined : { height: 0, opacity: 0, overflow: "hidden" }}
          transition={{ duration: reduce ? 0 : 0.28, ease: [0.2, 0.7, 0.2, 1] }}
          style={{ overflow: "hidden" }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
