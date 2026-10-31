import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import type { BudgetSettingsView } from "@/lib/budget-view"
import type { PickerNode } from "@/lib/transaction-list-view"
import { createRegistry } from "./repositories/fixtures"

// What the budget form and its two pages say, as markup, from literal props shaped exactly as the server sends them (paise
// as text, months as "YYYY-MM-01"). Rendering to markup has no app router, so the router is stubbed; the Server Actions are
// never called from a render. The pages are called as functions with the session replaced, over real database rows, for
// the not-found cases. Nothing here reads the clock: `today` is passed in, and the pages' own `today` is never asserted.

const { requireUserId, auth, UnauthenticatedError } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), auth: vi.fn(), UnauthenticatedError }
})
vi.mock("@/server/auth", () => ({ requireUserId, auth, UnauthenticatedError, signOut: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/app/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => children }))
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const { BudgetForm } = await import("@/app/budgets/budget-form")
const { default: NewBudgetPage } = await import("@/app/budgets/new/page")
const { default: EditBudgetPage } = await import("@/app/budgets/[id]/edit/page")

const TODAY = calendarDate("2026-11-15")

const node = (over: Partial<PickerNode> & Pick<PickerNode, "id" | "name" | "kind">): PickerNode => ({
  archived: false,
  systemRole: null,
  valuationMode: null,
  unitLabel: null,
  ...over,
})
const NODES: PickerNode[] = [
  node({ id: "salary", name: "Salary", kind: "INCOME_SOURCE" }),
  node({ id: "bank", name: "HDFC Savings", kind: "ASSET" }),
  node({ id: "food", name: "Groceries", kind: "EXPENSE" }),
  node({ id: "fun", name: "Eating out", kind: "EXPENSE" }),
  node({ id: "fees", name: "Fees", kind: "EXPENSE", systemRole: "FEES" as PickerNode["systemRole"] }),
  node({ id: "old", name: "Old ledger", kind: "EXPENSE", archived: true }),
  node({ id: "mf", name: "Index Fund", kind: "INVESTMENT", valuationMode: "CONTRIBUTION_ONLY" }),
]

const budget = (over: Partial<BudgetSettingsView> = {}): BudgetSettingsView => ({
  id: "b1",
  nodeId: "food",
  nodeName: "Groceries",
  amountPaise: "1234500",
  startMonth: "2026-04-01",
  endMonth: null,
  rollover: false,
  ...over,
})

const newForm = (nodes: PickerNode[] = NODES) => renderToStaticMarkup(createElement(BudgetForm, { nodes, today: TODAY, budget: null }))
const editForm = (over: Partial<BudgetSettingsView> = {}, nodes: PickerNode[] = NODES) =>
  renderToStaticMarkup(createElement(BudgetForm, { nodes, today: TODAY, budget: budget(over) }))

const accessibleText = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'")
const text = (html: string) => accessibleText(html).replace(/\s+/g, " ")
function selectOf(html: string, suffix: string): string {
  const select = html.match(new RegExp(`<select[^>]*id="[^"]*-${suffix}"[^>]*>([\\s\\S]*?)</select>`))
  expect(select, `a select ending in -${suffix}`).not.toBeNull()
  return select![0]
}
const optionNames = (html: string, suffix: string) =>
  [...selectOf(html, suffix).matchAll(/<option[^>]*>([\s\S]*?)<\/option>/g)].map((m) => accessibleText(m[1]))
const selectedValue = (html: string, suffix: string) => selectOf(html, suffix).match(/<option value="([^"]*)" selected/)?.[1]
const hasControl = (html: string, suffix: string) => new RegExp(`id="[^"]*-${suffix}"`).test(html)
const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ name: accessibleText(m[2]).trim(), attrs: m[1] }))
const links = (html: string): [string, string][] =>
  [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[1], accessibleText(m[2]).trim()])
const REVISION = "Changes the amount from November 2026; earlier months keep the old amount."

describe("the new budget form", () => {
  it("offers only the live, non-system expense ledgers", () => {
    const names = optionNames(newForm(), "node")
    expect(names).toEqual(["Choose a ledger", "Eating out", "Groceries"])
    expect(text(newForm())).not.toMatch(/Salary|HDFC|Index Fund|Fees|Old ledger/)
  })

  it("starts with no ledger chosen, so the user has to choose one", () => {
    expect(selectedValue(newForm(), "node")).toBe("")
  })

  it("defaults the start month to the current month and offers three years back and a year ahead", () => {
    const html = newForm()
    expect(selectedValue(html, "start")).toBe("2026-11")
    const names = optionNames(html, "start")
    expect(names[0]).toBe("November 2023")
    expect(names.at(-1)).toBe("November 2027")
    expect(names).toContain("November 2026")
  })

  it("has an optional end month that starts on No end", () => {
    const html = newForm()
    expect(text(html)).toContain("Last month")
    expect(optionNames(html, "end")[0]).toBe("No end")
    expect(selectedValue(html, "end")).toBe("")
    expect(html).toMatch(/<span[^>]*>optional<\/span>/)
  })

  it("has an amount in rupees, set to nothing", () => {
    const html = newForm()
    expect(text(html)).toContain("Monthly amount (₹)")
    expect(html).toMatch(/<input[^>]*id="[^"]*-amount"[^>]*inputMode="decimal"|<input[^>]*inputMode="decimal"[^>]*id="[^"]*-amount"/i)
  })

  it("has the rollover switch, off, with its one-line explanation", () => {
    const html = newForm()
    expect(html).toMatch(/<input[^>]*type="checkbox"/)
    expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/)
    expect(text(html)).toContain("Unspent budget carries into the next month")
  })

  it("has one button, Create budget, and a way back", () => {
    const html = newForm()
    expect(buttons(html).map((b) => b.name)).toEqual(["Create budget"])
    expect(links(html)).toContainEqual(["/budgets", "Cancel"])
  })

  it("has no Amount or Settings sections: those belong to an edit", () => {
    const html = newForm()
    expect(hasControl(html, "applies-from")).toBe(false)
    expect(text(html)).not.toContain("Applies from")
  })

  it("has no server imports in the client component or its helpers", () => {
    for (const file of ["budget-form.tsx", "budget-fields.ts"]) {
      const source = readFileSync(join(process.cwd(), "src/app/budgets", file), "utf8")
      const imports = [...source.matchAll(/^import (type )?[^\n]*from "([^"]+)"/gm)]
      for (const [, isType, from] of imports) {
        if (from.startsWith("@/server/")) expect(isType, `${file} imports ${from}`).toBe("type ")
        expect(from, file).not.toMatch(/@prisma\/client|server-only|\.\/actions-internal/)
      }
    }
  })
})

describe("the edit budget form", () => {
  it("has two sections, Amount and Settings, each with its own button", () => {
    const html = editForm()
    const headings = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => accessibleText(m[1]).trim())
    expect(headings).toEqual(["Amount", "Settings"])
    expect(buttons(html).map((b) => b.name)).toEqual(["Save amount", "Save settings"])
    expect(links(html)).toContainEqual(["/budgets", "Cancel"])
  })

  it("shows the budget's amount as rupee text and applies it from the current month by default", () => {
    const html = editForm()
    expect(html).toContain('value="12345.00"')
    expect(text(html)).toContain("Applies from")
    expect(selectedValue(html, "applies-from")).toBe("2026-11")
    expect(optionNames(html, "applies-from")[0]).toBe("April 2026")
    expect(optionNames(html, "applies-from").at(-1)).toBe("November 2026")
  })

  it("says in words what saving the amount will do, from describeRevision", () => {
    expect(text(editForm())).toContain(REVISION)
    expect(text(editForm({ startMonth: "2026-11-01" }))).toContain("Corrects the amount for every month of this budget.")
  })

  it("opens an ended budget on its end month, offers nothing after it, and does not open on the refusal sentence", () => {
    const html = editForm({ endMonth: "2026-10-01" })
    expect(selectedValue(html, "applies-from")).toBe("2026-10")
    expect(optionNames(html, "applies-from")[0]).toBe("April 2026")
    expect(optionNames(html, "applies-from").at(-1)).toBe("October 2026")
    expect(optionNames(html, "applies-from")).not.toContain("November 2026")
    expect(text(html)).toContain("Changes the amount from October 2026; earlier months keep the old amount.")
    expect(text(html)).not.toContain("This budget ended in")
    // A one-month budget in the past: its only month, which corrects it in place.
    const single = editForm({ startMonth: "2026-04-01", endMonth: "2026-04-01" })
    expect(optionNames(single, "applies-from")).toEqual(["April 2026"])
    expect(text(single)).toContain("Corrects the amount for every month of this budget.")
  })

  it("an end month in the future does not cap the applies-from list", () => {
    const html = editForm({ endMonth: "2027-03-01" })
    expect(optionNames(html, "applies-from").at(-1)).toBe("November 2026")
    expect(selectedValue(html, "applies-from")).toBe("2026-11")
  })

  it("puts that sentence in a polite live region, so a change of month is heard", () => {
    expect(editForm()).toMatch(/<p[^>]*aria-live="polite"[^>]*>[^<]*Changes the amount from/)
  })

  it("shows the end month and rollover as the budget has them, in Settings", () => {
    const html = editForm({ endMonth: "2027-03-01", rollover: true })
    expect(selectedValue(html, "end")).toBe("2027-03")
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/)
    expect(text(html)).toContain("Unspent budget carries into the next month")
    const settings = html.slice(html.indexOf("Settings"))
    expect(settings).toContain('type="checkbox"')
  })

  it("keeps the ledger fixed: shown, disabled, not a choice", () => {
    const html = editForm()
    expect(selectedValue(html, "node")).toBe("food")
    expect(selectOf(html, "node")).toMatch(/disabled/)
    expect(text(html)).toContain("A budget stays on its ledger")
  })

  it("shows an archived ledger for its own budget", () => {
    const html = editForm({ nodeId: "old", nodeName: "Old ledger" })
    expect(optionNames(html, "node")).toContain("Old ledger (archived)")
    expect(selectedValue(html, "node")).toBe("old")
  })

  it("has no start month: a budget's start is not moved by an edit", () => {
    expect(hasControl(editForm(), "start")).toBe(false)
  })
})

// -- The pages ------------------------------------------------------------------------------------------------------------

const registry = createRegistry()
afterAll(registry.cleanup)
beforeEach(() => {
  requireUserId.mockReset()
  auth.mockReset()
})

function elementsIn(node: ReactNode, found: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return
    found.push(child)
    elementsIn(child.props.children as ReactNode, found)
  })
  return found
}
const formOf = (tree: ReactNode) => elementsIn(tree).find((element) => element.type === BudgetForm)
const propsOf = (element: ReactElement | undefined) => element!.props as unknown as { nodes: PickerNode[]; today: string; budget: BudgetSettingsView | null }

async function signedIn() {
  const user = await registry.makeUser()
  requireUserId.mockResolvedValue(user.id)
  auth.mockResolvedValue({ user: { id: user.id, email: user.email }, expires: "2099-01-01" })
  return user
}
const newPage = () => NewBudgetPage()
const editPage = (id: string) => EditBudgetPage({ params: Promise.resolve({ id }) })

describe("the new budget page", () => {
  it("hands the form the user's expense ledgers and no budget", async () => {
    const user = await signedIn()
    const groceries = await registry.makeNode(user.id, "EXPENSE", "Groceries")
    await registry.makeNode(user.id, "ASSET", "Bank")
    await registry.makeNode(user.id, "EXPENSE", "Gone", { archivedAt: new Date() })
    const props = propsOf(formOf(await newPage()))
    expect(props.budget).toBeNull()
    expect(props.nodes.map((n) => n.id)).toEqual([groceries.id])
  })

  it("never shows another user's ledger", async () => {
    const user = await signedIn()
    const stranger = await registry.makeUser()
    await registry.makeNode(stranger.id, "EXPENSE", "Theirs")
    const mine = await registry.makeNode(user.id, "EXPENSE", "Mine")
    expect(propsOf(formOf(await newPage())).nodes.map((n) => n.id)).toEqual([mine.id])
  })
})

describe("the edit budget page", () => {
  it("hands the form the budget, as plain data, and its ledger", async () => {
    const user = await signedIn()
    const groceries = await registry.makeNode(user.id, "EXPENSE", "Groceries")
    const row = await registry.makeBudget(user.id, groceries.id, { amountPaise: 1_234_500n, startMonth: "2026-04-01", endMonth: "2027-03-01", rollover: true })
    const props = propsOf(formOf(await editPage(row.id)))
    expect(props.budget).toEqual({
      id: row.id,
      nodeId: groceries.id,
      nodeName: "Groceries",
      amountPaise: "1234500",
      startMonth: "2026-04-01",
      endMonth: "2027-03-01",
      rollover: true,
    })
    expect(props.nodes.map((n) => n.id)).toContain(groceries.id)
    expect(() => JSON.stringify(props)).not.toThrow()
  })

  it("offers the budget's ledger even when it has been archived since", async () => {
    const user = await signedIn()
    const old = await registry.makeNode(user.id, "EXPENSE", "Old", { archivedAt: new Date() })
    const row = await registry.makeBudget(user.id, old.id)
    const props = propsOf(formOf(await editPage(row.id)))
    expect(props.nodes).toContainEqual(expect.objectContaining({ id: old.id, archived: true }))
    expect(props.budget?.nodeId).toBe(old.id)
  })

  it("is a plain 404 for a budget that does not exist, an empty id, or another user's", async () => {
    const user = await signedIn()
    const stranger = await registry.makeUser()
    const theirLedger = await registry.makeNode(stranger.id, "EXPENSE", "Theirs")
    const theirs = await registry.makeBudget(stranger.id, theirLedger.id)
    const mine = await registry.makeNode(user.id, "EXPENSE", "Mine")
    await registry.makeBudget(user.id, mine.id)
    const notFound = { digest: expect.stringContaining("404") }
    await expect(editPage("no-such-budget")).rejects.toMatchObject(notFound)
    await expect(editPage("")).rejects.toMatchObject(notFound)
    await expect(editPage(theirs.id)).rejects.toMatchObject(notFound)
  })
})
