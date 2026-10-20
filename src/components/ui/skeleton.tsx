import { cn } from "@/lib/utils"

// A grey stand-in, with a band of light travelling across it, for a thing that has not arrived yet. Purely visual:
// hidden from assistive technology, because a screen reader should hear that the page is loading (see LoadingScreen) rather
// than a list of empty boxes.
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton", className)} />
}
