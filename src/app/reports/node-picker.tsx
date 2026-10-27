"use client"

import { useRouter } from "next/navigation"
import { Fragment, useId, useTransition } from "react"
import { buttonClass, inputClass } from "@/components/ui/styles"
import type { RangeChoice } from "@/domain/periods"
import { reportHref, type ReportSlug } from "@/lib/report-nav"
import { cn } from "@/lib/utils"

// Which account or investment a report is looking at. Like the range, the choice lives in the URL (`node=<id>`), so it can
// be bookmarked and the back button undoes it. Choosing is not enough to go anywhere: as with the range control and the
// Transactions filters, "Show" applies it, so moving through the options with the keyboard never changes the page
// underneath (WCAG 3.2.2). It goes to the same report over the same range with the new node; an option whose value is
// empty ("All investments") leaves the node out. The select is uncontrolled, so it keeps what was chosen while the page
// loads; the report remounts it (keyed by the node shown) once the new page arrives. Archived ones are listed, and say
// so, because a closed account still has a history.

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

  function apply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const node = String(new FormData(event.currentTarget).get("node") ?? "") || undefined
    startTransition(() => router.push(reportHref(slug, choice, { node })))
  }

  const options = (list: PickerOption[]) =>
    list.map((option) => (
      <option key={option.value} value={option.value}>
        {optionText(option)}
      </option>
    ))

  return (
    <form
      onSubmit={apply}
      aria-label={`Report ${label.toLowerCase()}`}
      className="surface flex flex-col gap-1.5 rounded-3xl p-4 sm:flex-row sm:items-center sm:gap-4 sm:p-5"
    >
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-3">
        <select id={id} name="node" defaultValue={value} className={cn(inputClass, "min-w-0 flex-1 sm:w-72 sm:flex-none")}>
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
        <button type="submit" aria-busy={pending || undefined} className={buttonClass({ variant: "secondary", size: "md" })}>
          Show
        </button>
      </div>
    </form>
  )
}
