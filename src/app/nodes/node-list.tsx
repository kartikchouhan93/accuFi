"use client"

import { useRouter } from "next/navigation"
import { useId, useState, useTransition } from "react"
import type { LedgerKind, SystemNodeRole } from "@/domain/ledger-kind"
import { HOLDING_KINDS, KIND_COPY, KIND_ORDER } from "@/lib/node-kinds"
import { describeBalance, describeResidual, formatPaiseText } from "@/lib/node-money"
import type { NodeOverview } from "@/lib/node-overview"
import type { NodeView } from "@/lib/node-view"
import type { ActionResult } from "@/server/action-support"
import { Amount } from "@/app/amount"
import { archiveNodeAction, archiveResidualAction, removeNodeAction, renameNodeAction, restoreNodeAction } from "./actions"
import { choiceLabel } from "./node-fields"
import { describeFailure, type FailureText } from "./node-failure"
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
      <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)}
          className="size-4 accent-pen"
        />
        Show archived
      </label>
      <div className="mt-6 space-y-10">
        {KIND_ORDER.map((kind) => (
          <KindSection
            key={kind}
            kind={kind}
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
  overview: NodeOverview
  showArchived: boolean
  announce: Props["announce"]
  onAdd: Props["onAdd"]
}

function KindSection({ kind, overview, showArchived, announce, onAdd }: SectionProps) {
  const headingId = useId()
  const copy = KIND_COPY[kind]
  const summary = overview.kinds[kind]
  // Ordinary nodes first, the system ones (which no user action can change) after them.
  const ofKind = overview.nodes
    .filter((node) => node.kind === kind)
    .sort((a, b) => Number(a.systemRole !== null) - Number(b.systemRole !== null))
  const visible = showArchived ? ofKind : ofKind.filter((node) => node.archivedAt === null)
  const hiddenCount = ofKind.length - visible.length
  const total = HOLDING_KINDS.has(kind) ? describeBalance(kind, summary.total) : null

  return (
    <section aria-labelledby={headingId}>
      <div className="flex items-baseline gap-3 border-b-2 border-fg pb-1">
        <h2 id={headingId} className="font-display text-xl font-semibold">
          {copy.plural}
        </h2>
        {total && (
          <>
            <span className="leader" aria-hidden="true" />
            <Amount text={total} className="text-lg font-medium" />
          </>
        )}
      </div>
      {/* The figure above counts archived nodes whether or not their rows are drawn; say so when they are not. */}
      {hiddenCount > 0 && (
        <p className="mt-1 text-sm text-fg-soft">
          {total ? "Includes " : ""}
          {hiddenCount} archived{total ? ", not listed" : " not listed"}.
        </p>
      )}
      {visible.length === 0 ? (
        <p className="mt-3 text-fg-soft">
          {ofKind.length === 0 ? copy.empty : "Everything here is archived."}{" "}
          {ofKind.length === 0 && (
            <button type="button" onClick={() => onAdd(kind)} className="font-medium text-link underline underline-offset-4">
              Add {copy.indefinite}
            </button>
          )}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((node) => (
            <NodeRow key={node.id} node={node} balance={overview.balances[node.id] ?? "0"} announce={announce} />
          ))}
        </ul>
      )}
    </section>
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
  ]
  return lines.filter((line): line is [string, string] => line[1] !== null)
}

interface RowProps {
  node: NodeView
  balance: string
  announce: Props["announce"]
}

function NodeRow({ node, balance, announce }: RowProps) {
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

  const buttonClass =
    "rounded-sm border border-line-strong px-3 py-1.5 text-sm font-medium hover:bg-canvas disabled:opacity-60"
  const primaryClass = "rounded-sm bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-60"
  const dangerClass = "rounded-sm bg-negative px-3 py-1.5 text-sm font-medium text-panel disabled:opacity-60"

  return (
    <li className={isArchived ? "bg-panel/50" : undefined}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 py-3 text-left"
      >
        <span className={`font-medium ${isArchived ? "text-fg-soft" : ""}`}>
          <span>{node.name}</span>
          {isSystem && <Tag>System</Tag>}
          {isArchived && <Tag>Archived</Tag>}
        </span>
        {shownBalance ? (
          <>
            <span className="leader" aria-hidden="true" />
            <Amount text={shownBalance} />
          </>
        ) : (
          // A system node has no figure to run a leader to.
          <span className="col-span-2" aria-hidden="true" />
        )}
        {sub && <span className="col-span-3 text-sm text-fg-soft">{sub}</span>}
      </button>

      {open && (
        <div id={panelId} className="pb-4 text-sm">
          {isSystem ? (
            <p className="max-w-prose text-fg-soft">
              {SYSTEM_ROLE_NOTE[node.systemRole as SystemNodeRole]} AccuFi keeps this one for you, so it cannot be
              renamed, archived or deleted.
            </p>
          ) : (
            <>
              {details(node).length > 0 && (
                <dl className="mb-3 grid max-w-md grid-cols-[auto_1fr] gap-x-6 gap-y-0.5">
                  {details(node).map(([label, value]) => (
                    <div key={label} className="contents">
                      <dt className="text-fg-soft">{label}</dt>
                      <dd className="figures">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {mode === "idle" && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={buttonClass} onClick={() => setMode("rename")}>
                    Rename
                  </button>
                  {isArchived ? (
                    <button type="button" className={buttonClass} disabled={pending} onClick={restore}>
                      Restore
                    </button>
                  ) : (
                    <button type="button" className={buttonClass} disabled={pending} onClick={chooseArchive}>
                      Archive
                    </button>
                  )}
                  <button type="button" className={`${buttonClass} text-negative`} onClick={() => setMode("confirm-delete")}>
                    Delete
                  </button>
                </div>
              )}

              {mode === "rename" && (
                <form
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
                    className="mt-1 w-full rounded-sm border border-line-strong bg-canvas px-3 py-2 aria-[invalid=true]:border-2 aria-[invalid=true]:border-negative"
                  />
                  {nameErrors.length > 0 && (
                    <p id={`${panelId}-name-error`} className="mt-1 font-medium text-negative">
                      {nameErrors.join(" ")}
                    </p>
                  )}
                  <div className="mt-2 flex gap-2">
                    <button type="submit" className={primaryClass} disabled={pending}>
                      Save name
                    </button>
                    <button
                      type="button"
                      className={buttonClass}
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
                </form>
              )}

              {mode === "confirm-archive" && (
                <div className="max-w-lg bg-notice-wash p-3 text-notice-fg">
                  <p>
                    {residual
                      ? `${node.name} ${residual}. Archiving hides it from your lists, but that balance stays in your net worth. Move the money out first if it should leave.`
                      : `Archive ${node.name}? It leaves your lists and pickers, its history is kept, and you can restore it.`}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" className={primaryClass} disabled={pending} onClick={archive}>
                      Confirm archive
                    </button>
                    <button type="button" className={buttonClass} onClick={() => setMode("idle")}>
                      Keep it
                    </button>
                  </div>
                </div>
              )}

              {mode === "confirm-delete" && (
                <div className="max-w-lg bg-negative-wash p-3 text-negative">
                  <p>
                    Delete {node.name}? This cannot be undone. Only something with no transactions can be deleted: if it
                    has any, archive it instead.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" className={dangerClass} disabled={pending} onClick={remove}>
                      Confirm delete
                    </button>
                    <button type="button" className={buttonClass} onClick={() => setMode("idle")}>
                      Keep it
                    </button>
                  </div>
                </div>
              )}

              {failure && !(mode === "rename" && nameErrors.length > 0) && (
                <p role="alert" className="mt-3 max-w-lg bg-negative-wash px-3 py-2 font-medium text-negative">
                  {failure.message}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </li>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="ml-2 rounded-sm border border-line-strong px-1.5 py-0.5 align-middle text-xs font-normal text-fg-soft">{children}</span>
}
