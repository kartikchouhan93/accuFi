"use client"

import { CircleAlert, LoaderCircle, TriangleAlert } from "lucide-react"
import { useRouter } from "next/navigation"
import { useId, useRef, useState, useTransition } from "react"
import { Field } from "@/app/transactions/transaction-form"
import { buttonClass, inputClass } from "@/components/ui/styles"
import { IMPORT_DATE_FORMATS, parseImportDate, type ImportDateFormat, type SignConvention } from "@/domain/import-map"
import { IMPORT_DELIMITERS, IMPORT_ENCODINGS, type ImportDelimiter, type ImportEncoding } from "@/domain/import-csv"
import { PROFILE_NAME_MAX_LENGTH, SKIP_ROWS_MAX } from "@/lib/schemas/import"
import type { ActionFailure } from "@/server/action-support"
import type { MapScreen } from "@/server/services/import-service"
import { attempt, couldNot } from "@/app/feedback"
import { saveProfileAction, stageBatchAction } from "../../actions"
import { mappingControlsDiffer, paramsFromMapping } from "../../mapping-params"
import { PreviewTable } from "./preview-table"

// The map-and-preview screen (design §6 stage 2). The mapping controls are a plain `method="get"` form: "Update
// preview" is a full navigation back to this same page with new search parameters, which the server reads
// (mapping-params.ts) and turns straight back into the preview below. Only the two writes (Save as profile, Stage
// rows) are client-driven, the same way every other screen's actions are, and both send the mapping the preview was
// made with. So the one piece of client state here is whether the controls have been changed since that preview: while
// they have, Stage rows and Save mapping are held back ("Update the preview first"), so neither can ever write a
// mapping other than the one the person can see in the preview.

const DELIMITER_LABEL: Record<ImportDelimiter, string> = { ",": "Comma ( , )", ";": "Semicolon ( ; )", "\t": "Tab", "|": "Pipe ( | )" }
const ENCODING_LABEL: Record<ImportEncoding, string> = { "utf-8": "UTF-8", "windows-1252": "Windows-1252 (Latin-1)", "utf-16le": "UTF-16LE" }
const DECIMAL_LABEL: Record<"." | ",", string> = { ".": "Point, as in 1,234.56", ",": "Comma, as in 1.234,56" }

const DATE_SAMPLE: Record<ImportDateFormat, string> = {
  "DD/MM/YYYY": "03/04/2026",
  "MM/DD/YYYY": "03/04/2026",
  "YYYY-MM-DD": "2026-04-03",
  "DD-MM-YYYY": "03-04-2026",
  "DD/MM/YY": "03/04/26",
  "MM/DD/YY": "03/04/26",
  "DD-MMM-YYYY": "03-Apr-2026",
  "D MMM YYYY": "3 Apr 2026",
}
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/** What a sample date in this format reads as, computed live from the real parser: never a hardcoded claim. */
function workedDateExample(format: ImportDateFormat): string {
  const sample = DATE_SAMPLE[format]
  const result = parseImportDate(sample, format)
  if (!result.ok) return `"${sample}" ${result.error}.`
  const [, month, day] = result.value.split("-")
  return `"${sample}" reads as ${Number(day)} ${FULL_MONTHS[Number(month) - 1]}.`
}

/** What a positive or negative amount means on this account, in its own terms: a deposit reads differently from a charge. */
function signSentence(kind: "ASSET" | "LIABILITY", sign: SignConvention): string {
  if (kind === "ASSET") {
    return sign === "POSITIVE_IN"
      ? "A positive amount is money coming into this account, such as a deposit; a negative amount leaves it."
      : "A positive amount leaves this account, such as a withdrawal or a payment; a negative amount comes into it."
  }
  return sign === "POSITIVE_OUT"
    ? "A positive amount increases what this account owes, such as a new purchase; a negative amount decreases it, such as a payment."
    : "A positive amount decreases what this account owes, such as a payment; a negative amount increases it, such as a new purchase."
}

function describeFailure(failure: ActionFailure): { message: string; fieldErrors: Record<string, string[]> } {
  return { message: failure.error.message, fieldErrors: failure.error.fieldErrors ?? {} }
}

interface Props {
  batchId: string
  basePath: string
  screen: MapScreen
}

export function MapForm({ batchId, basePath, screen }: Props) {
  const router = useRouter()
  const formId = useId()
  const { account, mapping, decodeError, sample, headerCells, previewRows, profiles, earlier, batch } = screen
  const currentParams = paramsFromMapping(mapping)
  // Which preview the controls were last compared against: a new screen (a new mapping) resets the comparison, so a
  // stale "changed" from the previous preview never carries over.
  const previewKey = JSON.stringify(currentParams)
  const [changedSince, setChangedSince] = useState<string | null>(null)
  const controlsChanged = changedSince === previewKey
  const staleId = `${formId}-stale`

  function onControlsChange(event: React.FormEvent<HTMLFormElement>) {
    const values: Record<string, string> = {}
    for (const [name, value] of new FormData(event.currentTarget)) if (typeof value === "string") values[name] = value
    setChangedSince(mappingControlsDiffer(values, currentParams) ? previewKey : null)
  }

  const columnCount = Math.max(headerCells.length, ...previewRows.map((row) => row.cells.length), 0)
  const columnLabel = (index: number) => {
    const cell = headerCells[index]
    return cell && cell.trim() !== "" ? cell : `Column ${index + 1}`
  }

  // Staging and saving a profile both write; the mapping-controls form above them only ever navigates (GET).
  const [confirmedRepeat, setConfirmedRepeat] = useState(false)
  const [stageOutcome, setStageOutcome] = useState<{ message: string; fieldErrors: Record<string, string[]> } | null>(null)
  const [stagePending, startStaging] = useTransition()
  const stageInFlight = useRef(false)

  const [profileName, setProfileName] = useState("")
  const [profileOutcome, setProfileOutcome] = useState<{ message: string; saved: string | null } | null>(null)
  const [profilePending, startSavingProfile] = useTransition()
  const profileInFlight = useRef(false)

  function stage() {
    if (controlsChanged) {
      setStageOutcome({ message: "Update the preview first: the mapping above has changed since this preview was made.", fieldErrors: {} })
      return
    }
    if (earlier && !confirmedRepeat) {
      setStageOutcome({ message: "Confirm the repeat upload below before staging this import.", fieldErrors: {} })
      return
    }
    if (stageInFlight.current) return
    stageInFlight.current = true
    startStaging(async () => {
      try {
        const result = await attempt(() => stageBatchAction({ id: batchId, mapping, confirmedRepeat }))
        if (result === null || !result.ok) {
          setStageOutcome(result === null ? { message: couldNot("stage this import", null), fieldErrors: {} } : describeFailure(result))
          if (result !== null && !result.ok && result.error.code === "not_found") router.refresh()
          return
        }
        router.push(`/import/${batchId}/review`)
      } finally {
        stageInFlight.current = false
      }
    })
  }

  function saveAsProfile() {
    const name = profileName.trim()
    if (controlsChanged) {
      setProfileOutcome({ message: "Update the preview first: the mapping above has changed since this preview was made.", saved: null })
      return
    }
    if (name === "") {
      setProfileOutcome({ message: "Enter a name for this mapping.", saved: null })
      return
    }
    if (profileInFlight.current) return
    profileInFlight.current = true
    startSavingProfile(async () => {
      try {
        const result = await attempt(() => saveProfileAction({ name, nodeId: account.id, mapping }))
        if (result === null || !result.ok) {
          setProfileOutcome({ message: result === null ? couldNot("save this mapping", null) : result.error.message, saved: null })
          return
        }
        setProfileOutcome({ message: `Saved as "${result.data.name}".`, saved: result.data.name })
      } finally {
        profileInFlight.current = false
      }
    })
  }

  return (
    <div className="space-y-6">
      {earlier && (
        <section role="alert" className="rounded-2xl border border-notice-fg/60 bg-notice-wash p-4 text-sm text-notice-fg">
          <p className="flex items-start gap-2.5 font-medium">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              This exact file was uploaded before, on {new Date(earlier.uploadedAt).toLocaleDateString()}
              {earlier.status === "DISCARDED" ? "" : ` (now ${earlier.status.toLowerCase()})`}.
            </span>
          </p>
          <p className="mt-1">Staging it again may record the same entries twice.</p>
        </section>
      )}

      {decodeError && (
        <p role="alert" className="flex items-start gap-2.5 rounded-xl bg-negative-wash px-3.5 py-2.5 text-sm font-medium text-negative">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{decodeError} Try a different encoding below.</span>
        </p>
      )}

      {sample.length > 0 && (
        <section aria-labelledby={`${formId}-sample-heading`} className="surface rounded-2xl p-4 sm:p-5">
          <h2 id={`${formId}-sample-heading`} className="font-display text-lg font-semibold tracking-tight">
            The file, as decoded
          </h2>
          <p className="mt-1 text-sm text-fg-soft">The first {sample.length} lines, exactly as this encoding reads them.</p>
          <pre className="figures mt-3 overflow-x-auto rounded-xl border border-line-strong bg-canvas/60 p-3 text-xs">
            {sample.join("\n")}
          </pre>
        </section>
      )}

      <section aria-labelledby={`${formId}-mapping-heading`} className="surface rounded-2xl p-4 sm:p-5">
        <h2 id={`${formId}-mapping-heading`} className="font-display text-lg font-semibold tracking-tight">
          How to read this file
        </h2>
        {profiles.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-sm text-fg-soft">Use a saved mapping:</span>
            {profiles.map((profile) => (
              <form key={profile.id} method="get" action={basePath}>
                <input type="hidden" name="profile" value={profile.id} />
                <button type="submit" className={buttonClass({ variant: "secondary", size: "sm" })}>
                  {profile.name}
                </button>
              </form>
            ))}
          </div>
        )}

        <form key={previewKey} method="get" action={basePath} onChange={onControlsChange} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field idBase={`${formId}-delim`} label="Column delimiter" errors={undefined}>
              {(props) => (
                <select {...props} name="delim" defaultValue={currentParams.delim} className={inputClass}>
                  {IMPORT_DELIMITERS.map((delimiter) => (
                    <option key={delimiter} value={delimiter}>
                      {DELIMITER_LABEL[delimiter]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field idBase={`${formId}-enc`} label="Text encoding" errors={undefined}>
              {(props) => (
                <select {...props} name="enc" defaultValue={currentParams.enc} className={inputClass}>
                  {IMPORT_ENCODINGS.map((encoding) => (
                    <option key={encoding} value={encoding}>
                      {ENCODING_LABEL[encoding]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          <Field idBase={`${formId}-skip`} label="Header rows to skip" hint={`A number from 0 to ${SKIP_ROWS_MAX}`} errors={undefined}>
            {(props) => (
              <input
                {...props}
                type="number"
                name="skip"
                min={0}
                max={SKIP_ROWS_MAX}
                inputMode="numeric"
                defaultValue={currentParams.skip}
                className={`${inputClass} figures`}
              />
            )}
          </Field>

          <Field idBase={`${formId}-datefmt`} label="Date format" hint={workedDateExample(mapping.dateFormat)} errors={undefined}>
            {(props) => (
              <select {...props} name="datefmt" defaultValue={currentParams.datefmt} className={inputClass}>
                {IMPORT_DATE_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {format}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field idBase={`${formId}-dec`} label="Decimal separator" errors={undefined}>
              {(props) => (
                <select {...props} name="dec" defaultValue={currentParams.dec} className={inputClass}>
                  <option value=".">{DECIMAL_LABEL["."]}</option>
                  <option value=",">{DECIMAL_LABEL[","]}</option>
                </select>
              )}
            </Field>
            <Field idBase={`${formId}-sign`} label="Positive amounts mean" hint={signSentence(account.kind, mapping.signConvention)} errors={undefined}>
              {(props) => (
                <select {...props} name="sign" defaultValue={currentParams.sign} className={inputClass}>
                  <option value="POSITIVE_IN">Money coming in</option>
                  <option value="POSITIVE_OUT">Money going out</option>
                </select>
              )}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field idBase={`${formId}-cdate`} label="Date column" errors={undefined}>
              {(props) => (
                <select {...props} name="cdate" defaultValue={currentParams.cdate} className={inputClass}>
                  <option value="-1">Choose a column</option>
                  {Array.from({ length: columnCount }, (_, index) => (
                    <option key={index} value={index}>
                      {columnLabel(index)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field idBase={`${formId}-cdesc`} label="Description column" errors={undefined}>
              {(props) => (
                <select {...props} name="cdesc" defaultValue={currentParams.cdesc} className={inputClass}>
                  <option value="-1">Choose a column</option>
                  {Array.from({ length: columnCount }, (_, index) => (
                    <option key={index} value={index}>
                      {columnLabel(index)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          <div>
            <p className="text-sm font-medium">Amount columns</p>
            <p className="mt-1 text-xs text-fg-soft">Choose a single amount column, or both a debit and a credit column, not both.</p>
            <div className="mt-2 grid gap-4 sm:grid-cols-3">
              <Field idBase={`${formId}-camount`} label="Amount column" optional errors={undefined}>
                {(props) => (
                  <select {...props} name="camount" defaultValue={currentParams.camount ?? ""} className={inputClass}>
                    <option value="">Not used</option>
                    {Array.from({ length: columnCount }, (_, index) => (
                      <option key={index} value={index}>
                        {columnLabel(index)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field idBase={`${formId}-cdebit`} label="Debit column" optional errors={undefined}>
                {(props) => (
                  <select {...props} name="cdebit" defaultValue={currentParams.cdebit ?? ""} className={inputClass}>
                    <option value="">Not used</option>
                    {Array.from({ length: columnCount }, (_, index) => (
                      <option key={index} value={index}>
                        {columnLabel(index)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field idBase={`${formId}-ccredit`} label="Credit column" optional errors={undefined}>
                {(props) => (
                  <select {...props} name="ccredit" defaultValue={currentParams.ccredit ?? ""} className={inputClass}>
                    <option value="">Not used</option>
                    {Array.from({ length: columnCount }, (_, index) => (
                      <option key={index} value={index}>
                        {columnLabel(index)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
          </div>

          <button type="submit" className={buttonClass({ variant: controlsChanged ? "primary" : "secondary" })}>
            Update preview
          </button>
          {controlsChanged && (
            <p id={staleId} role="status" className="text-sm font-medium text-notice-fg">
              Update the preview first: the mapping above has changed since the preview below was made.
            </p>
          )}
        </form>
      </section>

      <section aria-labelledby={`${formId}-preview-heading`} className="surface rounded-2xl p-4 sm:p-5">
        <h2 id={`${formId}-preview-heading`} className="font-display text-lg font-semibold tracking-tight">
          Preview
        </h2>
        <p className="mt-1 text-sm text-fg-soft">
          The first {previewRows.length} of {batch.rowCount > 0 ? batch.rowCount : previewRows.length} rows, as they will be recorded.
        </p>
        <PreviewTable rows={previewRows} />
      </section>

      <section aria-labelledby={`${formId}-profile-heading`} className="surface rounded-2xl p-4 sm:p-5">
        <h2 id={`${formId}-profile-heading`} className="font-display text-lg font-semibold tracking-tight">
          Save as profile
        </h2>
        <p className="mt-1 text-sm text-fg-soft">Reuse this exact mapping the next time you import a statement from this bank.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            saveAsProfile()
          }}
          className="mt-3 flex flex-wrap items-end gap-3"
        >
          <Field idBase={`${formId}-profile-name`} label="Name" errors={undefined}>
            {(props) => (
              <input
                {...props}
                type="text"
                maxLength={PROFILE_NAME_MAX_LENGTH}
                autoComplete="off"
                placeholder="My bank"
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <button
            type="submit"
            aria-disabled={profilePending || controlsChanged}
            aria-describedby={controlsChanged ? staleId : undefined}
            className={buttonClass({ variant: "secondary", className: "aria-disabled:opacity-55" })}
          >
            {profilePending && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
            Save mapping
          </button>
        </form>
        {profileOutcome && (
          <p role="status" className={`mt-2 text-sm ${profileOutcome.saved ? "text-fg-soft" : "font-medium text-negative"}`}>
            {profileOutcome.message}
          </p>
        )}
      </section>

      <section aria-labelledby={`${formId}-stage-heading`} className="surface rounded-2xl p-4 sm:p-5">
        <h2 id={`${formId}-stage-heading`} className="font-display text-lg font-semibold tracking-tight">
          Stage rows
        </h2>
        <p className="mt-1 text-sm text-fg-soft">Nothing is recorded yet. Staging reads every row with the mapping above, so you can decide each one on the next screen.</p>

        {earlier && (
          <label className="mt-3 flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={confirmedRepeat}
              onChange={(event) => setConfirmedRepeat(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 rounded border-line-strong"
            />
            <span>I understand this file was uploaded before, and want to stage it again anyway.</span>
          </label>
        )}

        {stageOutcome && (
          <p role="alert" className="mt-3 flex items-start gap-2.5 rounded-xl bg-negative-wash px-3.5 py-2.5 text-sm font-medium text-negative">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{stageOutcome.message}</span>
          </p>
        )}

        <div className="mt-4">
          <button
            type="button"
            aria-disabled={stagePending || controlsChanged || Boolean(decodeError) || (Boolean(earlier) && !confirmedRepeat)}
            aria-describedby={controlsChanged ? staleId : undefined}
            onClick={stage}
            className={buttonClass({ className: "aria-disabled:opacity-55" })}
          >
            {stagePending && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
            Stage rows
          </button>
        </div>
      </section>
    </div>
  )
}
