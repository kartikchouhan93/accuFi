import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, describe, expect, it, vi } from "vitest"
import type { ReviewFilter, ReviewRowView, ReviewScreen, BatchView } from "@/lib/import-view"
import type { CommitSummary } from "@/server/services/import-service"
import type { PickerNode, TransactionScreen } from "@/lib/transaction-list-view"
import type { TransactionView } from "@/lib/transaction-view"
import { createRegistry } from "./repositories/fixtures"

// What the review screen, the batch page, the Transactions row's "Imported" tag and the `?batch=` notice say, as
// markup, from literal views shaped exactly as the server sends them (paise as text, days as "YYYY-MM-DD").
// Rendering to markup has no app router, so the router is stubbed; the Server Actions are never called from a
// render (renderToStaticMarkup has no event handling, so a click handler is simply never reached). The two new
// pages' redirect and not-found rules are tested against the real database (real rows), the same way Task 10's own
// /import/[id] redirect tests are: loadReview/loadBatchPage are left real so a wrong-status or foreign batch answers
// exactly as production does.

const { requireUserId, auth, UnauthenticatedError, redirect } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), auth: vi.fn(), UnauthenticatedError, redirect: vi.fn() }
})
vi.mock("@/server/auth", () => ({ requireUserId, auth, UnauthenticatedError, signOut: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/app/app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }))
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  redirect,
}))

const { ReviewRow, buildImportChange } = await import("@/app/import/[id]/review/review-row")
const { ReviewFilters } = await import("@/app/import/[id]/review/review-filters")
const { CommitBar, backToMappingConfirmText, discardConfirmText } = await import("@/app/import/[id]/review/commit-bar")
const { ReviewWorkspace } = await import("@/app/import/[id]/review/review-workspace")
const { default: ReviewPage } = await import("@/app/import/[id]/review/page")
const { BatchWorkspace, reverseConfirmText } = await import("@/app/import/[id]/batch/batch-workspace")
const { default: BatchPage } = await import("@/app/import/[id]/batch/page")
const { EntryRow } = await import("@/app/transactions/transaction-row")
const { TransactionWorkspace } = await import("@/app/transactions/transaction-workspace")

/** All the text, the screen-reader-only parts included: what a control is announced as. */
const accessibleText = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'")
/** What is on screen: without the text that only a screen reader reads. */
const visibleText = (html: string) => accessibleText(html.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, ""))
const decode = (value: string) => value.replace(/&amp;/g, "&")

interface Control {
  name: string
  attrs: string
}
const buttons = (html: string): Control[] =>
  [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ name: accessibleText(m[2]).replace(/\s+/g, " ").trim(), attrs: m[1] }))
const buttonNamed = (html: string, name: string | RegExp) => buttons(html).find((b) => (typeof name === "string" ? b.name === name : name.test(b.name)))
const links = (html: string): [string, string][] =>
  [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [decode(m[1]), accessibleText(m[2]).replace(/\s+/g, " ").trim()])

function selectBlock(html: string, name: string): string {
  const match = new RegExp(`<select[^>]*id="${name}"[^>]*>([\\s\\S]*?)<\\/select>`).exec(html)
  return match ? match[1] : ""
}
function optionLabels(html: string, selectId: string): string[] {
  return [...selectBlock(html, selectId).matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => decode(m[1]))
}
function selectedValue(html: string, selectId: string): string | null {
  const match = /<option[^>]*value="([^"]*)"[^>]*selected/.exec(selectBlock(html, selectId))
  return match ? match[1] : null
}

// -- fixtures ----------------------------------------------------------------------------------------------------

const ACCOUNT: ReviewScreen["account"] = { id: "bank1", name: "Bank", kind: "ASSET" }

const LEDGERS: ReviewScreen["ledgers"] = [
  { id: "food1", name: "Food", kind: "EXPENSE", archived: false },
  { id: "salary1", name: "Salary", kind: "INCOME_SOURCE", archived: false },
  { id: "card1", name: "Card", kind: "LIABILITY", archived: false },
]

const row = (over: Partial<ReviewRowView> = {}): ReviewRowView => ({
  id: "row1",
  line: 7,
  status: "PENDING",
  errorReason: null,
  occurredOn: "2026-04-03",
  amountPaise: "50000",
  direction: "OUT",
  description: "Coffee shop",
  descriptionKey: "coffee shop",
  counterpartNodeId: null,
  duplicate: null,
  occurrence: null,
  raw: ["03/04/2026", "Coffee shop", "500.00"],
  ...over,
})

const BATCH: BatchView = {
  id: "batch1",
  nodeId: "bank1",
  accountName: "Bank",
  fileName: "statement.csv",
  fileSize: 2048,
  status: "STAGED",
  rowCount: 5,
  createdAt: "2026-04-01T10:00:00.000Z",
  committedAt: null,
  reversedAt: null,
}

const COUNTS: ReviewScreen["counts"] = { pending: 3, ready: 41, skipped: 1, errored: 2, duplicates: 0, linked: 0 }

const SCREEN = (over: Partial<ReviewScreen> = {}): ReviewScreen => ({
  batch: BATCH,
  account: ACCOUNT,
  filter: "all",
  page: 1,
  pageCount: 1,
  counts: COUNTS,
  rows: [row()],
  ledgers: LEDGERS,
  canCommit: false,
  ...over,
})

const SUMMARY = (over: Partial<CommitSummary> = {}): CommitSummary => ({
  imported: 12,
  skipped: 1,
  linked: 2,
  errored: 0,
  firstDate: "2026-04-01",
  lastDate: "2026-04-28",
  totalInPaise: "100000",
  totalOutPaise: "50000",
  committedAt: "2026-05-01T09:00:00.000Z",
  ...over,
})

// -- ReviewRow ---------------------------------------------------------------------------------------------------

describe("ReviewRow", () => {
  const html = (r: ReviewRowView, siblings: ReviewRowView[] = [r]) =>
    renderToStaticMarkup(createElement("ul", null, createElement(ReviewRow, { row: r, account: ACCOUNT, ledgers: LEDGERS, siblings, announce: vi.fn() })))

  it("a pending row with no suggestion offers a counterpart and Import/Skip, nothing pre-selected", () => {
    const out = html(row())
    expect(selectedValue(out, "ledger-row1")).toBe("") // the placeholder "Choose a ledger…" option, not a real ledger

    expect(buttonNamed(out, "Import line 7")).toBeTruthy()
    expect(buttonNamed(out, "Skip line 7")).toBeTruthy()
    expect(out).not.toContain("Use this ledger for every row that reads the same")
  })

  it("final review I4: while a commit is in flight (locked) every control of a pending row is aria-disabled, not removed", () => {
    const r = row({ counterpartNodeId: "food1" })
    const locked = renderToStaticMarkup(
      createElement("ul", null, createElement(ReviewRow, { row: r, account: ACCOUNT, ledgers: LEDGERS, siblings: [r], announce: vi.fn(), locked: true })),
    )
    expect(buttonNamed(locked, "Import line 7")!.attrs).toContain('aria-disabled="true"')
    expect(buttonNamed(locked, "Skip line 7")!.attrs).toContain('aria-disabled="true"')
    expect(locked).toMatch(/<select[^>]*id="ledger-row1"[^>]*aria-disabled="true"|<select[^>]*aria-disabled="true"[^>]*id="ledger-row1"/)
    const open = html(r)
    expect(buttonNamed(open, "Import line 7")!.attrs).toContain('aria-disabled="false"')
  })

  it("a pending row with a suggested counterpart marks it in the select and preselects it", () => {
    const out = html(row({ counterpartNodeId: "food1" }))
    expect(selectedValue(out, "ledger-row1")).toBe("food1")
    expect(optionLabels(out, "ledger-row1").some((label) => label.includes("Food") && label.includes("Suggested"))).toBe(true)
  })

  it("limits the counterpart select to ledgers legal for the row's direction: an OUT row from an asset account never offers an income source", () => {
    const outRow = html(row({ direction: "OUT" }))
    const labels = optionLabels(outRow, "ledger-row1")
    expect(labels.some((l) => l.includes("Food"))).toBe(true) // ASSET -> EXPENSE is a legal spend
    expect(labels.some((l) => l.includes("Salary"))).toBe(false) // ASSET -> INCOME_SOURCE is not a real flow

    const inRow = html(row({ direction: "IN" }))
    const inLabels = optionLabels(inRow, "ledger-row1")
    expect(inLabels.some((l) => l.includes("Salary"))).toBe(true) // INCOME_SOURCE -> ASSET (a deposit) is legal
  })

  it("a ready row shows its decision and only Undo, with the exact amount", () => {
    const out = html(row({ status: "READY", counterpartNodeId: "food1", amountPaise: "123456789012345678" }))
    expect(visibleText(out)).toContain("₹1,23,45,67,89,01,23,456.78")
    expect(visibleText(out)).toContain("Ready")
    expect(visibleText(out)).toContain("Food")
    expect(buttonNamed(out, "Undo line 7")).toBeTruthy()
    expect(buttonNamed(out, /^Import/)).toBeFalsy()
    expect(buttonNamed(out, /^Skip/)).toBeFalsy()
  })

  it("a skipped row shows only Undo", () => {
    const out = html(row({ status: "SKIPPED" }))
    expect(visibleText(out)).toContain("Skipped")
    expect(buttonNamed(out, "Undo line 7")).toBeTruthy()
  })

  it("an errored row shows its reason and the raw cells, with no controls at all", () => {
    const out = html(row({ status: "ERRORED", errorReason: "The amount column is not a number", direction: null, amountPaise: null, occurredOn: null, raw: ["x", "y", "z"] }))
    expect(visibleText(out)).toContain("The amount column is not a number")
    expect(visibleText(out)).toContain("x · y · z")
    expect(out).not.toContain("<select")
    expect(out).not.toContain("<button")
  })

  it("a duplicate-flagged row shows the matched transaction side by side, a link, and Import anyway / Skip as duplicate only", () => {
    const out = html(
      row({
        duplicate: { transactionId: "t1", occurredAt: "2026-04-02", amountPaise: "50000", note: "Lunch", otherLedgerName: "Food" },
      }),
    )
    expect(visibleText(out)).toContain("2 Apr 2026") // the match's own date (2026-04-02), formatted
    expect(visibleText(out)).toContain("Lunch")
    expect(visibleText(out).includes("Food")).toBe(true)
    expect(buttonNamed(out, "Import anyway line 7")).toBeTruthy()
    expect(buttonNamed(out, "Skip as duplicate line 7")).toBeTruthy()
    expect(buttonNamed(out, "Import line 7")).toBeFalsy()
    expect(buttonNamed(out, "Skip line 7")).toBeFalsy()
    expect(links(out).some(([href, text]) => href.startsWith("/transactions?") && text === "See it in Transactions")).toBe(true)
  })

  it("a row matched to a pending recurring occurrence offers to link it, by name and due date", () => {
    const out = html(row({ occurrence: { id: "occ1", ruleName: "Gym", dueOn: "2026-04-05", otherNodeId: "food1" } }))
    expect(visibleText(out)).toContain("Gym")
    expect(buttonNamed(out, /^Link to Gym due 5 Apr 2026/)).toBeTruthy()
  })

  it("offers 'Use this ledger for every row that reads the same' once a counterpart is chosen and another pending row reads the same", () => {
    const a = row({ id: "a", counterpartNodeId: "food1", descriptionKey: "coffee shop", direction: "OUT" })
    const b = row({ id: "b", descriptionKey: "coffee shop", direction: "OUT" })
    expect(html(a, [a, b])).toContain("Use this ledger for every row that reads the same")
    // No sibling reads the same: the button is not offered even with a counterpart chosen.
    expect(html(a, [a])).not.toContain("Use this ledger for every row that reads the same")
  })

  // Staging computes `duplicateOfTransactionId` and `occurrenceId` independently (import-service.ts), so a row can be
  // BOTH duplicate-flagged AND matched to a pending recurring occurrence at once. `doImport`'s plain Import button and
  // the duplicate row's "Import anyway" both build their change through this one shared function: if a user picks
  // their own counterpart (different from the occurrence's own ledger) and imports anyway, the occurrence match must
  // be unlinked, or `prepareReadyRow` would silently re-derive the counterpart from the occurrence's rule at commit
  // time instead of honouring the explicit choice — posting to the wrong ledger with no warning.
  it("importing a row that is both duplicate-flagged and occurrence-matched, with an explicit counterpart, unlinks the occurrence rather than leaving it to override the choice at commit", () => {
    const dualFlagged = row({
      duplicate: { transactionId: "t1", occurredAt: "2026-04-02", amountPaise: "50000", note: "Lunch", otherLedgerName: "Food" },
      occurrence: { id: "occ1", ruleName: "Gym", dueOn: "2026-04-05", otherNodeId: "food1" },
    })
    const change = buildImportChange(dualFlagged, "card1") // the user's own choice, different from the occurrence's own ledger (food1)
    expect(change).toEqual({ decision: "IMPORT", occurrence: "UNLINK", counterpartNodeId: "card1" })
  })

  it("importing a plain (non-duplicate) occurrence-matched row with no explicit counterpart still unlinks the occurrence, carrying no counterpart for the server to override", () => {
    const occurrenceOnly = row({ occurrence: { id: "occ1", ruleName: "Gym", dueOn: "2026-04-05", otherNodeId: "food1" } })
    expect(buildImportChange(occurrenceOnly, "")).toEqual({ decision: "IMPORT", occurrence: "UNLINK" })
  })

  it("importing a row with no occurrence match leaves `occurrence` out of the change entirely", () => {
    expect(buildImportChange(row(), "food1")).toEqual({ decision: "IMPORT", counterpartNodeId: "food1" })
  })
})

// -- ReviewFilters -------------------------------------------------------------------------------------------------

describe("ReviewFilters", () => {
  it("shows every filter with its own count and marks the current one aria-current", () => {
    const html = renderToStaticMarkup(createElement(ReviewFilters, { batchId: "batch1", filter: "pending" as ReviewFilter, counts: COUNTS }))
    expect(html).toContain("(3)") // pending
    expect(html).toContain("(2)") // errors
    expect(html).toContain("(41)") // ready
    expect(html).toContain("(1)") // skipped
    const current = links(html).find(([href]) => href.includes("filter=pending"))
    expect(current).toBeTruthy()
    expect(/aria-current="page"[^>]*>[^<]*Needs a decision/.test(html) || /Needs a decision[\s\S]{0,40}aria-current="page"/.test(html)).toBe(true)
  })
})

// -- CommitBar -----------------------------------------------------------------------------------------------------

describe("CommitBar", () => {
  const html = (counts: ReviewScreen["counts"], canCommit: boolean) =>
    renderToStaticMarkup(createElement(CommitBar, { batchId: "batch1", fileName: "statement.csv", counts, canCommit, announce: vi.fn() }))

  it("shows the summary line in the documented shape", () => {
    const out = html(COUNTS, false)
    expect(visibleText(out)).toContain("3 need a decision, 2 errors, 41 ready, 1 skipped.")
  })

  it("Commit is aria-disabled with a reason naming the pending rows, when any are pending", () => {
    const out = html({ ...COUNTS, pending: 3, ready: 0 }, false)
    const commit = buttonNamed(out, "Commit")!
    expect(commit.attrs).toContain('aria-disabled="true"')
    expect(visibleText(out)).toContain("3 rows still need a decision.")
  })

  it("Commit is aria-disabled with a reason saying nothing is ready, when nothing is pending but nothing is ready either", () => {
    const out = html({ pending: 0, ready: 0, skipped: 2, errored: 1, duplicates: 0, linked: 0 }, false)
    expect(buttonNamed(out, "Commit")!.attrs).toContain('aria-disabled="true"')
    expect(visibleText(out)).toContain("No rows are ready to import.")
  })

  it("Commit is not disabled once every row is decided and at least one is ready", () => {
    const out = html({ pending: 0, ready: 5, skipped: 1, errored: 0, duplicates: 0, linked: 0 }, true)
    expect(buttonNamed(out, "Commit")!.attrs).not.toContain('aria-disabled="true"')
  })

  it("Back to mapping and Discard each toggle their own confirm region, closed by default", () => {
    const out = html(COUNTS, true)
    const back = buttonNamed(out, "Back to mapping")!
    expect(back.attrs).toContain('aria-expanded="false"')
    const discard = buttonNamed(out, "Discard")!
    expect(discard.attrs).toContain('aria-expanded="false"')
  })

  // `Collapse` removes a closed confirm's text from the document entirely, so the exact wording it would show is
  // pinned here directly against the exported functions rather than against a render.
  it("names exactly what Back to mapping and Discard would do", () => {
    expect(backToMappingConfirmText("statement.csv")).toBe(
      "Every decision staged on statement.csv's rows is discarded; you will stage it again from the mapping screen.",
    )
    expect(discardConfirmText()).toBe("This removes every row it staged. No transaction has been recorded from it, so nothing else is touched.")
  })
})

// -- ReviewWorkspace (the whole screen body) ------------------------------------------------------------------------

describe("ReviewWorkspace", () => {
  it("renders the file name, the filters, the commit bar and every row", () => {
    const html = renderToStaticMarkup(createElement(ReviewWorkspace, { batchId: "batch1", screen: SCREEN({ rows: [row(), row({ id: "row2", line: 8, status: "ERRORED", errorReason: "Bad amount", direction: null, amountPaise: null, occurredOn: null })] }) }))
    expect(visibleText(html)).toContain("statement.csv")
    expect(visibleText(html)).toContain("Bad amount")
    expect(links(html).some(([href]) => href === "/import")).toBe(true)
  })

  it("shows 'No rows match this filter' for an empty page", () => {
    const html = renderToStaticMarkup(createElement(ReviewWorkspace, { batchId: "batch1", screen: SCREEN({ rows: [] }) }))
    expect(visibleText(html)).toContain("No rows match this filter.")
  })
})

// -- BatchWorkspace --------------------------------------------------------------------------------------------------

describe("BatchWorkspace", () => {
  it("a committed batch shows its counts, date range, totals, a link to its transactions, and offers Reverse", () => {
    const html = renderToStaticMarkup(createElement(BatchWorkspace, { batch: BATCH, summary: SUMMARY({ imported: 12, linked: 2 }) }))
    const text = visibleText(html)
    expect(text).toContain("Committed")
    expect(text).toContain("12") // imported
    expect(text).toContain("1 Apr 2026")
    expect(text).toContain("28 Apr 2026")
    expect(links(html)).toContainEqual(["/transactions?batch=batch1", "See these transactions"])
    const reverse = buttonNamed(html, "Reverse this import")!
    expect(reverse).toBeTruthy()
    expect(reverse.attrs).toContain('aria-expanded="false"')
  })

  it("a reversed batch shows the reversal time and offers no Reverse button", () => {
    const reversedBatch: BatchView = { ...BATCH, status: "REVERSED", committedAt: "2026-05-01T09:00:00.000Z", reversedAt: "2026-05-02T12:30:00.000Z" }
    const html = renderToStaticMarkup(createElement(BatchWorkspace, { batch: reversedBatch, summary: SUMMARY() }))
    expect(visibleText(html)).toContain("Reversed")
    expect(buttonNamed(html, "Reverse this import")).toBeFalsy()
  })

  // `Collapse` removes a closed confirm's text from the document entirely, so the exact wording it would show is
  // pinned here directly against the exported function rather than against a render.
  it("names exactly how many transactions Reverse would delete and how many recurring entries it reopens", () => {
    expect(reverseConfirmText(SUMMARY({ imported: 12, linked: 2 }))).toBe(
      "Reversing deletes the 12 transactions this import created and returns 2 linked recurring entries to pending.",
    )
    expect(reverseConfirmText(SUMMARY({ imported: 1, linked: 0 }))).toBe(
      "Reversing deletes the 1 transaction this import created and returns 0 linked recurring entries to pending.",
    )
  })
})

// -- The "Imported" tag on a Transactions row -----------------------------------------------------------------------

describe("the Imported tag on a transaction row", () => {
  const TODAY = "2026-04-10" as never
  const nodes = new Map<string, PickerNode>([
    ["bank", { id: "bank", name: "Bank", kind: "ASSET", archived: false, systemRole: null, valuationMode: null, unitLabel: null }],
    ["food", { id: "food", name: "Food", kind: "EXPENSE", archived: false, systemRole: null, valuationMode: null, unitLabel: null }],
  ])
  const context = { nodes, today: TODAY, announce: vi.fn(), onEdit: vi.fn() }
  const transaction = (over: Partial<TransactionView> = {}): TransactionView => ({
    id: "t1",
    fromNodeId: "bank",
    toNodeId: "food",
    amountPaise: "5000",
    occurredAt: "2026-04-01" as never,
    note: null,
    tags: [],
    groupId: null,
    importBatchId: null,
    deleted: false,
    version: 0,
    warnings: [],
    ...over,
  })
  const row = (view: TransactionView) =>
    renderToStaticMarkup(createElement("ul", null, createElement(EntryRow, { entry: { kind: "single", transaction: view }, context, startOpen: true })))

  it("shows no Imported tag for a hand-entered transaction", () => {
    expect(row(transaction())).not.toContain("Imported")
  })

  it("shows an Imported tag linking to the batch, for one an import created", () => {
    const html = row(transaction({ importBatchId: "batch1" }))
    expect(visibleText(html)).toContain("Imported")
    expect(links(html)).toContainEqual(["/import/batch1", "Imported"])
  })
})

// -- The `?batch=` notice on Transactions ---------------------------------------------------------------------------

describe("the batch notice on Transactions", () => {
  const SCREEN_T: TransactionScreen = {
    today: "2026-04-10" as never,
    nodes: [],
    balances: {},
    unvalued: {},
    priced: {},
    filter: { node: "", kind: "", flow: "", from: "", to: "", min: "", max: "", tag: "", q: "", deleted: "", batch: "batch1" },
    problems: {},
    page: { entries: [], nextCursor: null },
    netTotal: null,
  }

  it("names the import's file name and links to drop the filter, when a batch label is given", () => {
    const html = renderToStaticMarkup(createElement(TransactionWorkspace, { screen: SCREEN_T, batchNotice: { fileName: "statement.csv", dropHref: "/transactions" } }))
    expect(visibleText(html)).toContain("Showing entries from import statement.csv.")
    expect(links(html)).toContainEqual(["/transactions", "Show all transactions"])
  })

  it("shows no notice when there is none (no ?batch=, or it resolved to nothing)", () => {
    const html = renderToStaticMarkup(createElement(TransactionWorkspace, { screen: SCREEN_T, batchNotice: null }))
    expect(html).not.toContain("Showing entries from import")
  })
})

// -- The two new pages' redirect and not-found rules, against the real database --------------------------------------

describe("the redirect and not-found rules of /import/[id]/review, against the real database", () => {
  const registry = createRegistry()
  afterAll(registry.cleanup)

  const open = (id: string, query: Record<string, string> = {}) => ReviewPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(query) })

  async function world() {
    const user = await registry.makeUser()
    const bank = await registry.makeNode(user.id, "ASSET", "Bank")
    requireUserId.mockReset().mockResolvedValue(user.id)
    redirect.mockReset().mockImplementation(() => {
      throw new Error("NEXT_REDIRECT")
    })
    return { user, bank }
  }

  it("redirects an UPLOADED batch (not yet staged) through /import/[id]", async () => {
    const { user, bank } = await world()
    const batch = await registry.makeBatch(user.id, bank.id, { status: "UPLOADED" })
    await expect(open(batch.id)).rejects.toThrow("NEXT_REDIRECT")
    expect(redirect).toHaveBeenCalledWith(`/import/${batch.id}`)
  })

  it("redirects a COMMITTED batch through /import/[id] too", async () => {
    const { user, bank } = await world()
    const batch = await registry.makeBatch(user.id, bank.id, { status: "COMMITTED", committedAt: new Date() })
    await expect(open(batch.id)).rejects.toThrow("NEXT_REDIRECT")
    expect(redirect).toHaveBeenCalledWith(`/import/${batch.id}`)
  })

  it("renders a STAGED batch without redirecting", async () => {
    const { user, bank } = await world()
    const batch = await registry.makeBatch(user.id, bank.id, { status: "STAGED" })
    const element = await open(batch.id)
    expect(renderToStaticMarkup(element)).toContain(batch.fileName)
  })

  it("answers not-found for a foreign batch, the same as a ghost id", async () => {
    const { user } = await world()
    const stranger = await registry.makeUser()
    const theirBank = await registry.makeNode(stranger.id, "ASSET", "Theirs")
    const theirBatch = await registry.makeBatch(stranger.id, theirBank.id, { status: "STAGED" })
    requireUserId.mockResolvedValue(user.id)
    await expect(open(theirBatch.id)).rejects.toMatchObject({ digest: expect.stringContaining("404") })
    await expect(open("no-such-batch")).rejects.toMatchObject({ digest: expect.stringContaining("404") })
  })

  it("sends a missing session to /login", async () => {
    requireUserId.mockReset().mockRejectedValue(new UnauthenticatedError())
    redirect.mockReset().mockImplementation(() => {
      throw new Error("NEXT_REDIRECT")
    })
    await expect(open("whatever")).rejects.toThrow("NEXT_REDIRECT")
    expect(redirect).toHaveBeenCalledWith("/login")
  })
})

describe("the redirect and not-found rules of /import/[id]/batch, against the real database", () => {
  const registry = createRegistry()
  afterAll(registry.cleanup)

  const open = (id: string) => BatchPage({ params: Promise.resolve({ id }) })

  async function world() {
    const user = await registry.makeUser()
    const bank = await registry.makeNode(user.id, "ASSET", "Bank")
    requireUserId.mockReset().mockResolvedValue(user.id)
    redirect.mockReset().mockImplementation(() => {
      throw new Error("NEXT_REDIRECT")
    })
    return { user, bank }
  }

  it("redirects a STAGED batch (not yet committed) through /import/[id]", async () => {
    const { user, bank } = await world()
    const batch = await registry.makeBatch(user.id, bank.id, { status: "STAGED" })
    await expect(open(batch.id)).rejects.toThrow("NEXT_REDIRECT")
    expect(redirect).toHaveBeenCalledWith(`/import/${batch.id}`)
  })

  it("renders a COMMITTED batch without redirecting", async () => {
    const { user, bank } = await world()
    const batch = await registry.makeBatch(user.id, bank.id, { status: "COMMITTED", committedAt: new Date(), fileBytes: null })
    const element = await open(batch.id)
    expect(renderToStaticMarkup(element)).toContain(batch.fileName)
  })

  it("renders a REVERSED batch without redirecting", async () => {
    const { user, bank } = await world()
    const batch = await registry.makeBatch(user.id, bank.id, { status: "REVERSED", committedAt: new Date(), reversedAt: new Date(), fileBytes: null })
    const element = await open(batch.id)
    expect(renderToStaticMarkup(element)).toContain(batch.fileName)
  })

  it("answers not-found for a discarded or foreign batch", async () => {
    const { user, bank } = await world()
    const discarded = await registry.makeBatch(user.id, bank.id, { status: "DISCARDED", fileBytes: null })
    await expect(open(discarded.id)).rejects.toMatchObject({ digest: expect.stringContaining("404") })
    await expect(open("no-such-batch")).rejects.toMatchObject({ digest: expect.stringContaining("404") })
  })

  it("sends a missing session to /login", async () => {
    requireUserId.mockReset().mockRejectedValue(new UnauthenticatedError())
    redirect.mockReset().mockImplementation(() => {
      throw new Error("NEXT_REDIRECT")
    })
    await expect(open("whatever")).rejects.toThrow("NEXT_REDIRECT")
    expect(redirect).toHaveBeenCalledWith("/login")
  })
})

describe("loadBatchLabel, against the real database", () => {
  const registry = createRegistry()
  afterAll(registry.cleanup)

  it("names the batch's own file for its owner, and answers null for a foreign or missing batch", async () => {
    const { loadBatchLabel } = await import("@/server/services/import-service")
    const user = await registry.makeUser()
    const bank = await registry.makeNode(user.id, "ASSET", "Bank")
    const batch = await registry.makeBatch(user.id, bank.id, { fileName: "card-statement.csv" })
    await expect(loadBatchLabel(user.id, batch.id)).resolves.toEqual({ fileName: "card-statement.csv" })

    const stranger = await registry.makeUser()
    const theirBank = await registry.makeNode(stranger.id, "ASSET", "Theirs")
    const theirBatch = await registry.makeBatch(stranger.id, theirBank.id)
    await expect(loadBatchLabel(user.id, theirBatch.id)).resolves.toBeNull()
    await expect(loadBatchLabel(user.id, "no-such-batch")).resolves.toBeNull()
  })
})

// -- The new files use the house palette only --------------------------------------------------------------------

describe("the new review/batch files", () => {
  const importDir = join(process.cwd(), "src/app/import")
  const transactionsDir = join(process.cwd(), "src/app/transactions")
  const files = [
    join(importDir, "[id]/review/page.tsx"),
    join(importDir, "[id]/review/review-row.tsx"),
    join(importDir, "[id]/review/review-filters.tsx"),
    join(importDir, "[id]/review/commit-bar.tsx"),
    join(importDir, "[id]/review/review-workspace.tsx"),
    join(importDir, "[id]/batch/page.tsx"),
    join(importDir, "[id]/batch/batch-workspace.tsx"),
    join(transactionsDir, "transaction-row.tsx"),
    join(transactionsDir, "transaction-workspace.tsx"),
    join(transactionsDir, "page.tsx"),
  ]

  it("exist", () => {
    for (const name of files) expect(() => readFileSync(name, "utf8")).not.toThrow()
  })

  it("use the Graphite and Azure tokens only: no raw colours, no purple, no yellow", () => {
    for (const name of files) {
      const source = readFileSync(name, "utf8")
      expect(source, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(source, name).not.toMatch(/\b(rgb|rgba|hsl|oklch)\(/)
      expect(source, name).not.toMatch(/\b(?:bg|text|border|ring|from|via|to|fill|stroke|outline|shadow)-(?:purple|violet|indigo|fuchsia|yellow|amber|lime|red|green|blue|orange)(?:-\d+)?\b/)
    }
  })
})
