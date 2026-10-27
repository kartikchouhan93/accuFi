"use client"

import { useRouter } from "next/navigation"
import { Fragment, useId, useTransition } from "react"
import { inputClass } from "@/components/ui/styles"
import type { RangeChoice } from "@/domain/periods"
import { reportHref, type ReportSlug } from "@/lib/report-nav"
import { cn } from "@/lib/utils"

// Which account or investment a report is looking at. Like the range, the choice lives in the URL (`node=<id>`), so it can
// be bookmarked and the back button undoes it: choosing one goes to the same report over the same range with the new node.
// An option whose value is empty ("All investments") leaves the node out. Archived ones are listed, and say so, because a
// closed account still has a history.

export interface PickerOption {
  value: string
  label: string
  archived?: boolean
}

interface Props {
  slug: ReportSlug
  /** The range the report is shown over, kept in the URL the choice goes to. */
  choice: RangeChoice
  /** The visible label: "Account", "Investment". */
  label: string
  /** The option shown as chosen; empty for none. */
  value: string
  /** Options, under a heading when there is more than one kind of them. */
  groups: { label?: string; options: PickerOption[] }[]
  /** Shown first when nothing is chosen ("Choose an account"). */
  placeholder?: string
}

const optionText = (option: PickerOption) => (option.archived ? `${option.label} (archived)` : option.label)

export function NodePicker({ slug, choice, label, value, groups, placeholder }: Props) {
  const router = useRouter()
  const id = useId()
  const [pending, startTransition] = useTransition()

  function choose(event: React.ChangeEvent<HTMLSelectElement>) {
    const node = event.target.value || undefined
    startTransition(() => router.push(reportHref(slug, choice, { node })))
  }

  const options = (list: PickerOption[]) =>
    list.map((option) => (
      <option key={option.value} value={option.value}>
        {optionText(option)}
      </option>
    ))

  return (
    <div className="surface flex flex-col gap-1.5 rounded-3xl p-4 sm:flex-row sm:items-center sm:gap-4 sm:p-5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select id={id} value={value} onChange={choose} aria-busy={pending || undefined} className={cn(inputClass, "sm:w-72", pending && "opacity-70")}>
        {placeholder && value === "" && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {groups.map((group, index) =>
          group.label ? (
            <optgroup key={group.label} label={group.label}>
              {options(group.options)}
            </optgroup>
          ) : (
            <Fragment key={index}>{options(group.options)}</Fragment>
          ),
        )}
      </select>
    </div>
  )
}
