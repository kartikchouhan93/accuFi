import { cn } from "@/lib/utils"

// An on/off control that looks like a switch and is a checkbox. The real <input type="checkbox"> lies transparently over the
// whole control, so it is focusable, announced as a checkbox with the label as its name, toggled by the space bar and by a
// click anywhere on it; the track and knob only draw its state. No script: the sliding is a CSS transition.

export function Switch({
  checked,
  onChange,
  children,
  className,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <label
      className={cn(
        "relative inline-flex w-fit cursor-pointer select-none items-center gap-3 rounded-lg text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-focus",
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="peer absolute inset-0 z-10 size-full cursor-pointer opacity-0"
      />
      <span
        aria-hidden
        className="h-6 w-10 shrink-0 rounded-full border border-line-strong bg-panel-raised transition-colors duration-200 peer-checked:border-accent-edge peer-checked:bg-accent"
      />
      <span
        aria-hidden
        className="absolute left-[3px] top-1/2 size-[18px] -translate-y-1/2 rounded-full bg-fg-soft shadow transition-[transform,background-color] duration-200 peer-checked:translate-x-4 peer-checked:bg-accent-fg"
      />
      <span>{children}</span>
    </label>
  )
}
