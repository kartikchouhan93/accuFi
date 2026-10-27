"use client"

import { motion, useReducedMotion } from "motion/react"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import type { RangeChoice } from "@/domain/periods"
import { REPORTS, reportHref, type ReportSlug } from "@/lib/report-nav"
import { cn } from "@/lib/utils"

// One link per report, the current one marked for a screen reader (aria-current) and to the eye (a filled pill). Moving to
// another report keeps the range, so comparing two reports over the same months is one click. A highlight slides under the
// pointer from tab to tab, as the navigation rail does; it only draws, it is not what is selected. On a narrow screen the
// row scrolls sideways within itself (never the page), starting with the current tab in view. A scrolling row clips what
// overflows it, focus outlines included, so the row is padded on every side (more than the outline's 2px plus its 2px
// offset) and a matching negative margin puts it back where it was.

export function ReportTabs({ current, choice }: { current: ReportSlug; choice: RangeChoice }) {
  const reduce = useReducedMotion()
  const [over, setOver] = useState<ReportSlug | null>(null)
  const row = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const list = row.current
    const tab = list?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!list || !tab) return
    // Scroll only the row, never the page: scrollIntoView would also move the window.
    list.scrollLeft = tab.offsetLeft - (list.clientWidth - tab.offsetWidth) / 2
  }, [current])

  return (
    <nav aria-label="Reports" className="-mx-4 sm:mx-0">
      <ul
        ref={row}
        onPointerLeave={() => setOver(null)}
        className="-my-1.5 flex gap-1 overflow-x-auto px-4 py-1.5 [scrollbar-width:none] sm:-mx-1.5 sm:flex-wrap sm:px-1.5 [&::-webkit-scrollbar]:hidden"
      >
        {REPORTS.map((report) => {
          const active = report.slug === current
          return (
            <li key={report.slug} className="shrink-0">
              <Link
                href={reportHref(report.slug, choice)}
                aria-current={active ? "page" : undefined}
                onPointerEnter={() => setOver(report.slug)}
                className={cn(
                  "relative flex h-10 items-center rounded-xl px-4 text-sm font-medium whitespace-nowrap transition-colors",
                  active ? "text-accent-fg" : over === report.slug ? "text-fg" : "text-fg-soft",
                )}
              >
                {over === report.slug && !active && (
                  <motion.span
                    layoutId="report-tab-hover"
                    aria-hidden
                    className="absolute inset-0 rounded-xl bg-panel-raised ring-1 ring-line"
                    transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 560, damping: 42 }}
                  />
                )}
                {active && <span aria-hidden className="absolute inset-0 rounded-xl bg-accent shadow-[0_6px_18px_-8px_var(--accent)]" />}
                <span className="relative">{report.label}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
