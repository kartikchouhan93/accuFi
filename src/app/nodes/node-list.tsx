"use client"

import { ChevronDown, CircleAlert, Trash2, TriangleAlert } from "lucide-react"
import { motion } from "motion/react"
import { useRouter } from "next/navigation"
import { useId, useState, useTransition } from "react"
import { Amount } from "@/app/amount"
import { PriceLine } from "@/app/price-line"
import { Collapse } from "@/components/ui/collapse"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { Tag } from "@/components/ui/tag"
import { buttonClass, inputClass } from "@/components/ui/styles"
import { Switch } from "@/components/ui/switch"
import type { LedgerKind, SystemNodeRole } from "@/domain/ledger-kind"
import { NOT_VALUED_COPY, type NotValuedReason, type PriceState } from "@/lib/investment-view"
import { HOLDING_KINDS, KIND_COPY, KIND_ORDER } from "@/lib/node-kinds"
import { describeBalance, describeResidual, formatPaiseText } from "@/lib/node-money"
import { describeArchivedLine, describeUnvalued, type NodeOverview } from "@/lib/node-overview"
import type { NodeView } from "@/lib/node-view"
import { cn } from "@/lib/utils"
import type { ActionResult } from "@/server/action-support"
import { archiveNodeAction, archiveResidualAction, removeNodeAction, renameNodeAction, restoreNodeAction } from "./actions"
import { choiceLabel } from "./node-fields"
import { describeFailure, type FailureText } from "./node-failure"
import { KIND_ICON } from "./kind-icons"
import type { Notice } from "./node-workspace"

// The ledger, grouped by kind. It is handed EVERY node, archived ones included, and totals that were computed from all
// of them on the server. This file decides only which rows to draw: `visible` below is used to draw rows and for
// nothing else, so no figure on this screen is ever derived from a filtered list.

interface Props {
  overview: NodeOverview
  announce: (notice: Notice, moveFocus?: boolean) => void
  onAdd: (kind: LedgerKind) => void
}

const SYSTEM_ROLE_NOTE: Record<SystemNodeRole, string> = {
  OPENING_BALANCE: "Opening balances you enter come from here.",
  OPENING_BALANCE_CONTRA: "An opening balance that is overdrawn or owed is recorded against this.",
  REALISED_GAIN: "What you gain when you sell an investment is recorded here.",
  REALISED_LOSS: "What you lose when you sell an investment is recorded here.",
}

export function NodeList({ overview, announce, onAdd }: Props) {
  const [showArchived, setShowArchived] = useState(false)

  return (
    <div>
      <Switch checked={showArchived} onChange={setShowArchived}>
        Show archived
      </Switch>
      <div className="mt-6 space-y-6">
        {KIND_ORDER.map((kind, index) => (
          <KindSection
            key={kind}
            kind={kind}
            index={index}
            overview={overview}
            showArchived={showArchived}
            announce={announce}
            onAdd={onAdd}
          />
        ))}
      </div>
    </div>
  )
}

interface SectionProps {
  kind: LedgerKind
  index: number
  overview: NodeOverview
  showArchived: boolean
  announce: Props["announce"]
  onAdd: Props["onAdd"]
}

function KindSection({ kind, index, overview, showArchived, announce, onAdd }: SectionProps) {
  const headingId = useId()
  const copy = KIND_COPY[kind]
  const Icon = KIND_ICON[kind]
  const summary = overview.kinds[kind]
  // Ordinary nodes first, the system ones (which no user action can change) after them.
  const ofKind = overview.nodes
    .filter((node) => node.kind === kind)
    .sort((a, b) => Number(a.systemRole !== null) - Number(b.systemRole !== null))
  const visible = showArchived ? ofKind : ofKind.filter((node) => node.archivedAt === null)
  const hiddenCount = ofKind.length - visible.length
  const total = HOLDING_KINDS.has(kind) ? describeBalance(kind, summary.total) : null
  // An investment that cannot be valued counts as nothing in the total: said beside it, and never called "included".
  const leftOut = total ? describeUnvalued(summary) : null
  const hiddenUnvalued = showArchived ? 0 : summary.archivedUnvaluedCount

  return (
    <SpotlightCard
      as="section"
      aria-labelledby={headingId}
      className="surface rise rounded-3xl p-5 sm:p-6"
      style={{ "--i": index } as React.CSSProperties}
      radius={380}
      strength={9}
    >
      <div className="flex items-center gap-3">
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-panel-raised text-fg-soft">
          <Icon className="size-5" />
        </span>
        <h2 id={headingId} className="font-display text-lg font-semibold tracking-tight">
          {copy.plural}
        </h2>
        {leftOut && <span className="ml-auto text-sm text-notice-fg">{leftOut}</span>}
        {total && <Amount text={total} className={cn("text-lg font-medium", !leftOut && "ml-auto")} />}
      </div>
      {/* The figure above counts archived nodes whether or not their rows are drawn; say so when they are not. */}
      {hiddenCount > 0 && (
        <p className="mt-2 text-sm text-fg-soft">
          {total ? describeArchivedLine(hiddenCount, hiddenUnvalued) : `${hiddenCount} archived not listed.`}
        </p>
      )}
      {visible.length === 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 text-fg-soft">
          <p>{ofKind.length === 0 ? copy.empty : "Everything here is archived."}</p>
          {ofKind.length === 0 && (
            <button type="button" onClick={() => onAdd(kind)} className={buttonClass({ variant: "secondary", size: "sm" })}>
              Add {copy.indefinite}
            </button>
          )}
        </div>
      ) : (
        <ul className="-mx-2 mt-3 space-y-0.5">
          {visible.map((node) => (
            <NodeRow
              key={node.id}
              node={node}
              balance={overview.balances[node.id] ?? "0"}
              notValued={overview.unvalued[node.id] ?? null}
              priced={overview.priced[node.id] ?? null}
              announce={announce}
            />
          ))}
        </ul>
      )}
    </SpotlightCard>
  )
}

type Mode = "idle" | "rename" | "confirm-archive" | "confirm-delete"

function subtitle(node: NodeView): string | null {
  const parts = [
    choiceLabel("assetSubtype", node.assetSubtype) ?? choiceLabel("liabilitySubtype", node.liabilitySubtype),
    node.institution,
    node.lastFour ? `ending ${node.lastFour}` : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(", ") : null
}

function details(node: NodeView): [string, string][] {
  const lines: [string, string | null][] = [
    ["Type", choiceLabel("assetSubtype", node.assetSubtype) ?? choiceLabel("liabilitySubtype", node.liabilitySubtype)],
    ["Institution", node.institution],
    ["Account ends", node.lastFour],
    ["Credit limit", node.creditLimitPaise === null ? null : formatPaiseText(node.creditLimitPaise)],
    ["Statement day", node.statementDay === null ? null : String(node.statementDay)],
    ["Due day", node.dueDay === null ? null : String(node.dueDay)],
    ["Valued", choiceLabel("valuationMode", node.valuationMode)],
    ["Unit", node.unitLabel],
    ["Sells", choiceLabel("lotMethod", node.lotMethod)],
    ["Prices go stale after", node.stalePriceDays === null ? null : `${node.stalePriceDays} ${node.stalePriceDays === 1 ? "day" : "days"}`],
  ]
  return lines.filter((line): line is [string, string] => line[1] !== null)
}

interface RowProps {
  node: NodeView
  balance: string
  /** Set for an investment that could not be valued: its `balance` is then "0", and is not shown (EC-23). */
  notValued: NotValuedReason | null
  /** Set for an investment valued at a price: the price's day and staleness, shown under the value (EC-24). */
  priced: PriceState | null
  announce: Props["announce"]
}

// What replaces the action buttons when a choice needs confirming: it slides in so the change of state is seen.
const swap = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.2 } }

function NodeRow({ node, balance, notValued, priced, announce }: RowProps) {
  const router = useRouter()
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>("idle")
  const [draftName, setDraftName] = useState(node.name)
  const [failure, setFailure] = useState<FailureText | null>(null)
  const [nameErrors, setNameErrors] = useState<string[]>([])
  // What archiving would leave in the node, as of today, asked of the server when the user chose Archive. Not the figure
  // on the row: that is the page as it was loaded, and this is the one the confirm step has to be honest about.
  const [residualToConfirm, setResidualToConfirm] = useState("0")
  const [pending, startTransition] = useTransition()

  const isSystem = node.systemRole !== null
  const isArchived = node.archivedAt !== null
  const copy = KIND_COPY[node.kind]
  const sub = subtitle(node)
  const shownBalance = isSystem ? null : describeBalance(node.kind, balance)
  const residual = describeResidual(node.kind, residualToConfirm)
  const lines = details(node)

  function run<T>(call: () => Promise<ActionResult<T>>, onSuccess: (data: T) => void, refresh = true) {
    setFailure(null)
    setNameErrors([])
    startTransition(async () => {
      const result = await call()
      if (!result.ok) {
        setFailure(describeFailure(result))
        setNameErrors(result.error.fieldErrors?.name ?? [])
        setMode((current) => (current === "rename" ? current : "idle"))
        return
      }
      onSuccess(result.data)
      if (refresh) router.refresh()
    })
  }

  const chooseArchive = () =>
    run(
      () => archiveResidualAction({ nodeId: node.id }),
      ({ residualBalance }) => {
        setResidualToConfirm(residualBalance)
        setMode("confirm-archive")
      },
      false, // a read: nothing changed, so there is nothing to refresh
    )

  const archive = () =>
    run(
      () => archiveNodeAction({ nodeId: node.id }),
      ({ residualBalance }) => {
        const still = describeResidual(node.kind, residualBalance)
        announce(
          {
            tone: still ? "warning" : "success",
            text: `Archived ${node.name}.${still ? ` It ${still} and still counts toward your net worth.` : ""}`,
          },
          true,
        )
      },
    )

  const restore = () =>
    run(
      () => restoreNodeAction({ nodeId: node.id }),
      () => announce({ tone: "success", text: `Restored ${node.name}.` }),
    )

  const remove = () =>
    run(
      () => removeNodeAction({ nodeId: node.id }),
      () => announce({ tone: "success", text: `Deleted ${node.name}.` }, true),
    )

  const rename = () =>
    run(
      () => renameNodeAction({ nodeId: node.id, name: draftName }),
      ({ node: renamed, duplicateName }) => {
        setMode("idle")
        setDraftName(renamed.name)
        announce({
          tone: duplicateName ? "warning" : "success",
          text: `Renamed ${node.name} to ${renamed.name}.${duplicateName ? ` You already have ${copy.indefinite} called ${renamed.name}. Both are kept.` : ""}`,
        })
      },
    )

  const secondary = buttonClass({ variant: "secondary", size: "sm" })
  const primary = buttonClass({ size: "sm" })

  return (
    <li className={cn("rounded-2xl transition-colors duration-200", open && "bg-panel-raised/70", isArchived && "opacity-80")}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors duration-200 hover:bg-panel-raised"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className={cn("font-medium", isArchived && "text-fg-soft")}>{node.name}</span>
            {isSystem && <Tag>System</Tag>}
            {isArchived && <Tag>Archived</Tag>}
          </span>
          {sub && <span className="mt-0.5 block text-sm text-fg-soft">{sub}</span>}
        </span>
        {notValued ? (
          <span className="shrink-0 text-right">
            <span className="block font-medium text-fg-soft">Not valued</span>
            <span className="block text-xs text-fg-soft">{NOT_VALUED_COPY[notValued]}</span>
          </span>
        ) : priced && shownBalance ? (
          <span className="flex shrink-0 flex-col items-end gap-0.5">
            <Amount text={shownBalance} className="font-medium" />
            <PriceLine priced={priced} className="justify-end" />
          </span>
        ) : (
          shownBalance && <Amount text={shownBalance} className="shrink-0 font-medium" />
        )}
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-fg-soft transition-transform duration-200", open && "rotate-180")} />
      </button>

      <Collapse open={open} id={panelId}>
        <div className="px-3 pb-4 text-sm">
          {isSystem ? (
            <p className="max-w-prose text-fg-soft">
              {SYSTEM_ROLE_NOTE[node.systemRole as SystemNodeRole]} AccuFi keeps this one for you, so it cannot be
              renamed, archived or deleted.
            </p>
          ) : (
            <>
              {lines.length > 0 && (
                <dl className="mb-4 grid max-w-md grid-cols-[auto_1fr] gap-x-6 gap-y-1 rounded-xl border border-line bg-canvas/60 p-3">
                  {lines.map(([label, value]) => (
                    <div key={label} className="contents">
                      <dt className="text-fg-soft">{label}</dt>
                      <dd className="figures">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {mode === "idle" && (
                <motion.div {...swap} className="flex flex-wrap gap-2">
                  <button type="button" className={secondary} onClick={() => setMode("rename")}>
                    Rename
                  </button>
                  {isArchived ? (
                    <button type="button" className={secondary} disabled={pending} onClick={restore}>
                      Restore
                    </button>
                  ) : (
                    <button type="button" className={secondary} disabled={pending} onClick={chooseArchive}>
                      Archive
                    </button>
                  )}
                  <button type="button" className={buttonClass({ variant: "danger", size: "sm" })} onClick={() => setMode("confirm-delete")}>
                    Delete
                  </button>
                </motion.div>
              )}

              {mode === "rename" && (
                <motion.form
                  {...swap}
                  onSubmit={(event) => {
                    event.preventDefault()
                    rename()
                  }}
                  className="max-w-md"
                >
                  <label htmlFor={`${panelId}-name`} className="font-medium">
                    New name for {node.name}
                  </label>
                  <input
                    id={`${panelId}-name`}
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    maxLength={100}
                    autoComplete="off"
                    autoFocus
                    aria-invalid={nameErrors.length > 0 || undefined}
                    aria-describedby={nameErrors.length > 0 ? `${panelId}-name-error` : undefined}
                    className={cn(inputClass, "mt-1.5")}
                  />
                  {nameErrors.length > 0 && (
                    <p id={`${panelId}-name-error`} className="mt-1.5 font-medium text-negative">
                      {nameErrors.join(" ")}
                    </p>
                  )}
                  <div className="mt-3 flex gap-2">
                    <button type="submit" className={primary} disabled={pending}>
                      Save name
                    </button>
                    <button
                      type="button"
                      className={secondary}
                      onClick={() => {
                        setMode("idle")
                        setDraftName(node.name)
                        setNameErrors([])
                        setFailure(null)
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </motion.form>
              )}

              {mode === "confirm-archive" && (
                <motion.div {...swap} className="max-w-lg rounded-2xl bg-notice-wash p-4 text-notice-fg">
                  <p className="flex items-start gap-2.5">
                    <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                    <span>
                      {residual
                        ? `${node.name} ${residual}. Archiving hides it from your lists, but that balance stays in your net worth. Move the money out first if it should leave.`
                        : `Archive ${node.name}? It leaves your lists and pickers, its history is kept, and you can restore it.`}
                    </span>
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" className={primary} disabled={pending} onClick={archive}>
                      Confirm archive
                    </button>
                    <button type="button" className={secondary} onClick={() => setMode("idle")}>
                      Keep it
                    </button>
                  </div>
                </motion.div>
              )}

              {mode === "confirm-delete" && (
                <motion.div {...swap} className="max-w-lg rounded-2xl bg-negative-wash p-4 text-negative">
                  <p className="flex items-start gap-2.5">
                    <Trash2 aria-hidden className="mt-0.5 size-4 shrink-0" />
                    <span>
                      Delete {node.name}? This cannot be undone. Only something with no transactions can be deleted: if it
                      has any, archive it instead.
                    </span>
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" className={buttonClass({ variant: "danger", size: "sm" })} disabled={pending} onClick={remove}>
                      Confirm delete
                    </button>
                    <button type="button" className={secondary} onClick={() => setMode("idle")}>
                      Keep it
                    </button>
                  </div>
                </motion.div>
              )}

              {failure && !(mode === "rename" && nameErrors.length > 0) && (
                <p role="alert" className="mt-3 flex max-w-lg items-start gap-2.5 rounded-xl bg-negative-wash px-3.5 py-2.5 font-medium text-negative">
                  <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span>{failure.message}</span>
                </p>
              )}
            </>
          )}
        </div>
      </Collapse>
    </li>
  )
}


