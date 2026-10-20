"use client"

import { motion, useReducedMotion } from "motion/react"
import { memo } from "react"
import { cn } from "@/lib/utils"

// Light drifting down curved lines. Adapted from Aceternity UI's Background Beams, and used on exactly one kind of screen:
// sign-in and sign-up, where there is no data to compete with it. Changes from the original: 12 paths instead of 50, a
// duration derived from each path's position rather than Math.random() in render (which can disagree between server and
// browser), colours from the palette, and a still image for anyone who has asked for less motion.

// Twelve of the original curves, evenly spread across the field.
const PATHS = Array.from({ length: 12 }, (_, i) => {
  const o = i * 28
  return `M${-380 + o} ${-189 - o * 1.14}C${-380 + o} ${-189 - o * 1.14} ${-312 + o} ${216 - o * 1.14} ${152 + o} ${343 - o * 1.14}C${616 + o} ${470 - o * 1.14} ${684 + o} ${875 - o * 1.14} ${684 + o} ${875 - o * 1.14}`
})

export const BackgroundBeams = memo(function BackgroundBeams({ className }: { className?: string }) {
  const still = useReducedMotion()
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden [mask-image:radial-gradient(ellipse_at_center,#000_30%,transparent_75%)]", className)}>
      <svg className="absolute inset-0 size-full" viewBox="0 0 696 316" fill="none" preserveAspectRatio="xMidYMid slice">
        {PATHS.map((d, i) => (
          <path key={`line-${i}`} d={d} stroke="var(--line)" strokeOpacity="0.5" strokeWidth="0.5" />
        ))}
        {!still &&
          PATHS.map((d, i) => (
            <path key={`beam-${i}`} d={d} stroke={`url(#beam-${i})`} strokeOpacity="0.55" strokeWidth="0.6" />
          ))}
        <defs>
          {PATHS.map((_, i) => (
            <motion.linearGradient
              key={`gradient-${i}`}
              id={`beam-${i}`}
              gradientUnits="userSpaceOnUse"
              initial={{ x1: "0%", x2: "0%", y1: "0%", y2: "0%" }}
              animate={still ? undefined : { x1: ["0%", "100%"], x2: ["0%", "95%"], y1: ["0%", "100%"], y2: ["0%", `${93 + (i % 4) * 2}%`] }}
              transition={{ duration: 12 + (i % 5) * 2.5, ease: "easeInOut", repeat: Infinity, delay: i * 0.7 }}
            >
              <stop stopColor="var(--accent)" stopOpacity="0" />
              <stop stopColor="var(--accent)" />
              <stop offset="32.5%" stopColor="var(--link)" />
              <stop offset="100%" stopColor="var(--link)" stopOpacity="0" />
            </motion.linearGradient>
          ))}
        </defs>
      </svg>
    </div>
  )
})
