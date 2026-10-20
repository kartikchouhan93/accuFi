"use client"

import { motion, useMotionTemplate, useMotionValue } from "motion/react"
import { cn } from "@/lib/utils"

// A surface with a soft pool of light that follows the pointer while it is over the card. Adapted from Aceternity UI's Card
// Spotlight. The light is drawn by an overlay that ignores the pointer, so it never gets between a person and the controls
// inside, and it is decoration only: it carries no text and is hidden from assistive technology. When the pointer is not over
// the card (including on a touch screen, which has no hover) nothing is drawn.

interface SpotlightCardProps extends React.HTMLAttributes<HTMLElement> {
  /** The element to render: a section when the card is a labelled region, an li when it is a list item. */
  as?: "div" | "section" | "li"
  /** Width of the pool of light, in px. */
  radius?: number
  /** How strong the light is at its centre, as a percentage of the accent colour. */
  strength?: number
}

export function SpotlightCard({ as: Tag = "div", className, children, radius = 320, strength = 14, onPointerMove, onPointerLeave, ...rest }: SpotlightCardProps) {
  const x = useMotionValue(-999)
  const y = useMotionValue(-999)
  const light = useMotionTemplate`radial-gradient(${radius}px circle at ${x}px ${y}px, color-mix(in oklab, var(--accent) ${strength}%, transparent), transparent 70%)`

  return (
    <Tag
      {...rest}
      className={cn("group/spot relative isolate", className)}
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        x.set(event.clientX - box.left)
        y.set(event.clientY - box.top)
        onPointerMove?.(event)
      }}
      onPointerLeave={(event) => {
        x.set(-999)
        y.set(-999)
        onPointerLeave?.(event)
      }}
    >
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -inset-px -z-10 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover/spot:opacity-100"
        style={{ background: light }}
      />
      {children}
    </Tag>
  )
}
