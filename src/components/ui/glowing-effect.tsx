"use client"

import { animate } from "motion/react"
import { memo, useCallback, useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

// A border that lights up on the side of a card the pointer is nearest to. Adapted from Aceternity UI's Glowing Effect,
// with two changes: the gradient is the app's own marigold and iris (the original is a four-colour rainbow, which would
// compete with jade and coral, the colours that mean money), and nothing moves for someone who has asked for less motion.
//
// Put it inside a `relative` container with a border radius; it inherits the radius. It is purely decorative, so it is
// never focusable and carries no text.

interface GlowingEffectProps {
  /** How far outside the card the pointer still counts as near it, in px. */
  proximity?: number
  /** Fraction of the card's centre where the glow stays off, 0 to 1. */
  inactiveZone?: number
  /** Width of the lit arc, in degrees. */
  spread?: number
  borderWidth?: number
  /** Seconds the glow takes to swing round to the pointer. */
  movementDuration?: number
  className?: string
}

const GRADIENT = `repeating-conic-gradient(
  from 236.84deg at 50% 50%,
  var(--accent) 0%,
  var(--link) calc(25% / var(--times)),
  var(--accent) calc(50% / var(--times)),
  var(--link) calc(75% / var(--times)),
  var(--accent) calc(100% / var(--times))
)`

export const GlowingEffect = memo(function GlowingEffect({
  proximity = 48,
  inactiveZone = 0.6,
  spread = 36,
  borderWidth = 1.5,
  movementDuration = 1.2,
  className,
}: GlowingEffectProps) {
  const ref = useRef<HTMLDivElement>(null)
  const last = useRef({ x: 0, y: 0 })
  const frame = useRef(0)

  const move = useCallback(
    (point?: { x: number; y: number }) => {
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => {
        const element = ref.current
        if (!element) return
        const { left, top, width, height } = element.getBoundingClientRect()
        if (point) last.current = point
        const { x, y } = last.current
        const centreX = left + width / 2
        const centreY = top + height / 2

        if (Math.hypot(x - centreX, y - centreY) < 0.5 * Math.min(width, height) * inactiveZone) {
          element.style.setProperty("--active", "0")
          return
        }
        const near = x > left - proximity && x < left + width + proximity && y > top - proximity && y < top + height + proximity
        element.style.setProperty("--active", near ? "1" : "0")
        if (!near) return

        const from = Number.parseFloat(element.style.getPropertyValue("--start")) || 0
        const target = (180 * Math.atan2(y - centreY, x - centreX)) / Math.PI + 90
        const to = from + (((target - from + 180) % 360) - 180)

        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          element.style.setProperty("--start", String(to))
          return
        }
        animate(from, to, {
          duration: movementDuration,
          ease: [0.16, 1, 0.3, 1],
          onUpdate: (value) => element.style.setProperty("--start", String(value)),
        })
      })
    },
    [inactiveZone, proximity, movementDuration],
  )

  useEffect(() => {
    const onScroll = () => move()
    const onPointerMove = (event: PointerEvent) => move({ x: event.x, y: event.y })
    window.addEventListener("scroll", onScroll, { passive: true })
    document.body.addEventListener("pointermove", onPointerMove, { passive: true })
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current)
      window.removeEventListener("scroll", onScroll)
      document.body.removeEventListener("pointermove", onPointerMove)
    }
  }, [move])

  return (
    <div
      ref={ref}
      aria-hidden
      style={
        {
          "--spread": spread,
          "--start": "0",
          "--active": "0",
          "--times": "5",
          "--glow-width": `${borderWidth}px`,
          "--gradient": GRADIENT,
        } as React.CSSProperties
      }
      className={cn("pointer-events-none absolute inset-0 rounded-[inherit]", className)}
    >
      <div
        className={cn(
          "rounded-[inherit]",
          'after:absolute after:inset-[calc(-1*var(--glow-width))] after:rounded-[inherit] after:content-[""]',
          "after:[border:var(--glow-width)_solid_transparent]",
          "after:[background:var(--gradient)] after:[background-attachment:fixed]",
          "after:opacity-[var(--active)] after:transition-opacity after:duration-300",
          "after:[mask-clip:padding-box,border-box] after:[mask-composite:intersect]",
          "after:[mask-image:linear-gradient(#0000,#0000),conic-gradient(from_calc((var(--start)-var(--spread))*1deg),#00000000_0deg,#fff,#00000000_calc(var(--spread)*2deg))]",
        )}
      />
    </div>
  )
})
