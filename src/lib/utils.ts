import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

// The one way classes are combined: conditional classes through clsx, then conflicting Tailwind utilities resolved so
// the last one wins (a caller's `p-2` replaces a component's default `p-4` instead of fighting it).
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
