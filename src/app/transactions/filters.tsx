"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useId } from "react"
import { KIND_COPY, KIND_ORDER } from "@/lib/node-kinds"
import { FILTER_KEYS, type FilterValues, type PickerNode } from "@/lib/transaction-list-view"
import { groupByKind, nodeLabel } from "./pickers"

// What narrows the list. The filters live in the page's URL, so a filtered list can be bookmarked or shared, and the
// back button undoes a filter. Applying one navigates (a soft navigation: the form being typed in beside the list keeps
// what was typed). Every field is sent, blank ones too: a blank date means "no bound", which is how the default of the
// current month is left. The server parses them and says what is wrong beside the field (`problems`).

interface Props {
  filter: FilterValues
  problems: Record<string, string[]>
  /** Every node, archived included: history can be filtered by an account that has since been archived. */
  nodes: PickerNode[]
}

const inputClass =
  "w-full rounded-sm border border-rule-strong bg-paper px-3 py-1.5 text-ink placeholder:text-ink-soft/70 aria-[invalid=true]:border-red aria-[invalid=true]:border-2"

export function Filters({ filter, problems, nodes }: Props) {
  const router = useRouter()
  const formId = useId()

  function apply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const params = new URLSearchParams()
    for (const key of FILTER_KEYS) params.set(key, String(data.get(key) ?? ""))
    router.push(`/transactions?${params.toString()}`)
  }

  const field = (key: keyof FilterValues, label: string, control: React.ReactNode) => {
    const errors = problems[key]
    return (
      <div>
        <label htmlFor={`${formId}-${key}`} className="text-sm font-medium">
          {label}
        </label>
        <div className="mt-1">{control}</div>
        {errors && (
          <p id={`${formId}-${key}-error`} className="mt-1 text-sm font-medium text-red">
            {errors.join(" ")}
          </p>
        )}
      </div>
    )
  }
  const common = (key: keyof FilterValues) => ({
    id: `${formId}-${key}`,
    name: key,
    "aria-invalid": problems[key] ? (true as const) : undefined,
    "aria-describedby": problems[key] ? `${formId}-${key}-error` : undefined,
  })

  // `key` makes the fields start again from what the server resolved whenever it sends a different filter.
  return (
    <form key={JSON.stringify(filter)} onSubmit={apply} noValidate aria-label="Filter transactions" className="border border-rule bg-sheet p-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4">
        {field(
          "node",
          "Involving",
          <select {...common("node")} defaultValue={filter.node} className={inputClass}>
            <option value="">Any account or ledger</option>
            {groupByKind(nodes).map((group) => (
              <optgroup key={group.kind} label={group.label}>
                {group.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {nodeLabel(node)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>,
        )}
        {field(
          "kind",
          "Kind involved",
          <select {...common("kind")} defaultValue={filter.kind} className={inputClass}>
            <option value="">Any kind</option>
            {KIND_ORDER.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_COPY[kind].singular}
              </option>
            ))}
          </select>,
        )}
        {field("from", "From date", <input {...common("from")} type="date" defaultValue={filter.from} className={`${inputClass} figures`} />)}
        {field("to", "To date", <input {...common("to")} type="date" defaultValue={filter.to} className={`${inputClass} figures`} />)}
        {field(
          "min",
          "Min amount (₹)",
          <input {...common("min")} type="text" inputMode="decimal" autoComplete="off" defaultValue={filter.min} className={`${inputClass} figures`} />,
        )}
        {field(
          "max",
          "Max amount (₹)",
          <input {...common("max")} type="text" inputMode="decimal" autoComplete="off" defaultValue={filter.max} className={`${inputClass} figures`} />,
        )}
        {field("tag", "Tag", <input {...common("tag")} type="text" autoComplete="off" defaultValue={filter.tag} className={inputClass} />)}
        {field("q", "Note contains", <input {...common("q")} type="text" autoComplete="off" defaultValue={filter.q} className={inputClass} />)}
      </div>
      <div className="mt-4 flex items-center gap-4">
        <button type="submit" className="rounded-sm bg-pen px-4 py-2 text-sm font-medium text-pen-ink">
          Apply filters
        </button>
        <Link href="/transactions" className="text-sm font-medium text-pen underline underline-offset-4">
          Reset to this month
        </Link>
      </div>
    </form>
  )
}
