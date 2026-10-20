"use client"

import { motion, useReducedMotion } from "motion/react"
import { useId } from "react"
import { cn } from "@/lib/utils"

// One choice from a few, as radio buttons, with a highlight that slides to whichever is selected. Adapted from Aceternity UI's
// animated tabs. Underneath it is an ordinary radio group: every option is a real <input type="radio"> laid transparently
// over its label, so it is reachable by keyboard (arrow keys move the choice), announced as a radio by a screen reader, and
// clickable anywhere on the option. The sliding highlight only draws which one is selected; it is not what selects it.
//
// The caller supplies the <fieldset> and <legend>, since what the group is called depends on where it is.

export interface Choice<T extends string> {
  value: T
  label: string
  /** A second, smaller line: what choosing this means. Read as part of the option's name. */
  description?: string
}

interface ChoiceGroupProps<T extends string> {
  name: string
  value: T
  onChange: (value: T) => void
  options: readonly Choice<T>[]
  /** "pill": compact chips with a solid sliding fill. "card": larger options with a description, an outlined slide. */
  variant?: "pill" | "card"
  className?: string
}

export function ChoiceGroup<T extends string>({ name, value, onChange, options, variant = "pill", className }: ChoiceGroupProps<T>) {
  const slideId = useId()
  const reduce = useReducedMotion()
  const card = variant === "card"
  return (
    <div className={cn(card ? "grid grid-cols-2 gap-2" : "flex flex-wrap gap-1.5", className)}>
      {options.map((option) => {
        const selected = option.value === value
        return (
          <label
            key={option.value}
            className={cn(
              "relative cursor-pointer rounded-xl text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
              card ? "border border-line-strong px-3 py-2.5 hover:border-fg-soft" : "px-3.5 py-2 font-medium hover:bg-panel-raised",
              selected && !card && "text-accent-fg hover:bg-transparent",
              selected && card && "border-transparent",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              onChange={() => onChange(option.value)}
              className="absolute inset-0 z-10 size-full cursor-pointer opacity-0"
            />
            {selected && (
              <motion.span
                layoutId={slideId}
                aria-hidden
                className={cn("absolute inset-0 rounded-xl", card ? "border-2 border-accent-edge bg-accent/10" : "bg-accent shadow-[0_6px_18px_-8px_var(--accent)]")}
                transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 40 }}
              />
            )}
            <span className="relative flex items-start gap-2">
              {card && (
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
                    selected ? "border-accent-edge" : "border-line-strong",
                  )}
                >
                  <span className={cn("size-2 rounded-full bg-accent-edge transition-transform", selected ? "scale-100" : "scale-0")} />
                </span>
              )}
              <span className={cn(selected && card && "font-medium")}>
                {option.label}
                {option.description && <span className="block text-xs font-normal text-fg-soft">{option.description}</span>}
              </span>
            </span>
          </label>
        )
      })}
    </div>
  )
}
