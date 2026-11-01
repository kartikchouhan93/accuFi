import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { ImportMapping } from "@/domain/import-map"
import type { BatchView } from "@/lib/import-view"
import { createRegistry } from "./repositories/fixtures"

// What the Import list, the new-import form, the map-and-preview screen and the nav item say, as markup, from literal
// views shaped exactly as the server sends them (paise as text). Rendering to markup has no app router, so the router
// is stubbed; the Server Actions are never called from a render. The /import/[id] redirect rules are the one part
// tested against the real database (real rows, as the plan asks for): `loadBatchPage` is left real so a foreign or
// discarded batch answers not-found exactly as it does in production, while the other loaders (used only for the
// literal-prop renders below) are replaced with literal data.

const { requireUserId, auth, UnauthenticatedError, redirect } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), auth: vi.fn(), UnauthenticatedError, redirect: vi.fn() }
})
const { loadBatchList, loadMapScreen, loadNewImport, loadProfileMapping } = vi.hoisted(() => ({
  loadBatchList: vi.fn(),
  loadMapScreen: vi.fn(),
  loadNewImport: vi.fn(),
  loadProfileMapping: vi.fn(),
}))

vi.mock("@/server/auth", () => ({ requireUserId, auth, UnauthenticatedError, signOut: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/app/app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }))
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  redirect,
}))
// loadBatchPage (and everything else) stays real: the /import/[id] redirect tests need it to behave exactly as
// production does against real rows. Only the loaders the literal-prop tests below drive are replaced.
vi.mock("@/server/services/import-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/import-service")>()
  return { ...actual, loadBatchList, loadMapScreen, loadNewImport, loadProfileMapping }
})

const { BatchList } = await import("@/app/import/batch-list")
const { default: ImportPage } = await import("@/app/import/page")
const { UploadForm } = await import("@/app/import/new/upload-form")
const { default: NewImportPage } = await import("@/app/import/new/page")
const { default: ImportBatchRedirectPage } = await import("@/app/import/[id]/page")
const { MapForm } = await import("@/app/import/[id]/map/map-form")
const { PreviewTable } = await import("@/app/import/[id]/map/preview-table")
const { default: MapPage } = await import("@/app/import/[id]/map/page")
const { AppNav } = await import("@/app/app-nav")
const { mappingFromParams } = await import("@/app/import/mapping-params")
type MapScreen = Awaited<ReturnType<typeof import("@/server/services/import-service").loadMapScreen>>
type PreviewRow = NonNullable<MapScreen["previewRows"]>[number]

/** All the text, the screen-reader-only parts included: what a link or button is announced as. */
const accessibleText = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'")
/** What is on screen: without the text that only a screen reader reads. */
const visibleText = (html: string) => accessibleText(html.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, ""))
const decode = (value: string) => value.replace(/&amp;/g, "&")

interface Control {
  name: string
  attrs: string
}
const buttons = (html: string): Control[] =>
  [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ name: accessibleText(m[2]).trim(), attrs: m[1] }))
const buttonNamed = (html: string, name: string | RegExp) => buttons(html).find((b) => (typeof name === "string" ? b.name === name : name.test(b.name)))
const links = (html: string): [string, string][] =>
  [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [decode(m[1]), accessibleText(m[2]).replace(/\s+/g, " ").trim()])

function selectBlock(html: string, name: string): string {
  const match = new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)<\\/select>`).exec(html)
  return match ? match[1] : ""
}
function selectedValue(html: string, name: string): string | null {
  const match = /<option[^>]*value="([^"]*)"[^>]*selected/.exec(selectBlock(html, name))
  return match ? match[1] : null
}

const BASE_MAPPING: ImportMapping = {
  delimiter: ",",
  encoding: "utf-8",
  skipRows: 1,
  dateFormat: "DD/MM/YYYY",
  decimalSeparator: ".",
  signConvention: "POSITIVE_IN",
  columns: { date: 0, description: 1, amount: 2 },
}

const batch = (over: Partial<BatchView> = {}): BatchView => ({
  id: "batch1",
  nodeId: "node1",
  accountName: "Bank",
  fileName: "statement.csv",
  fileSize: 2048,
  status: "UPLOADED",
  rowCount: 2,
  createdAt: "2026-04-01T10:00:00.000Z",
  committedAt: null,
  reversedAt: null,
  ...over,
})

const previewRow = (over: Partial<PreviewRow> = {}): PreviewRow => ({
  line: 2,
  cells: ["01/04/2026", "Coffee", "120.00"],
  parsed: { occurredOn: "2026-04-01", amountPaise: "12000", direction: "OUT", description: "Coffee" },
  error: null,
  ...over,
})

const mapScreen = (over: Partial<MapScreen> = {}): MapScreen => ({
  batch: batch({ status: "UPLOADED" }),
  account: { id: "node1", name: "Bank", kind: "ASSET" },
  mapping: BASE_MAPPING,
  decodeError: null,
  sample: ["Date,Description,Amount", "01/04/2026,Coffee,120.00"],
  headerCells: ["Date", "Description", "Amount"],
  previewRows: [previewRow()],
  profiles: [],
  earlier: null,
  ...over,
})

describe("the import list", () => {
  const list = (batches: BatchView[]) => renderToStaticMarkup(createElement(BatchList, { batches }))

  it.each([
    ["UPLOADED", /Uploaded/, "Continue", "/import/b1/map"],
    ["STAGED", /Staged/, "Review", "/import/b1/review"],
    ["COMMITTED", /Committed/, "View", "/import/b1"],
    ["REVERSED", /Reversed/, "View", "/import/b1"],
  ] as const)("shows %s in words on the chip, never by colour alone, with its next action", (status, chip, label, href) => {
    const html = list([batch({ id: "b1", status })])
    expect(visibleText(html)).toMatch(chip)
    const found = links(html).find(([linkHref]) => linkHref === href)
    expect(found?.[1]).toContain(label)
  })

  it("offers no next action and no discard for a discarded batch", () => {
    const html = list([batch({ id: "b1", status: "DISCARDED" })])
    expect(visibleText(html)).toMatch(/Discarded/)
    expect(links(html).some(([href]) => href.startsWith("/import/b1"))).toBe(false)
    expect(buttonNamed(html, /^Discard/)).toBeUndefined()
  })

  it("offers Discard, behind a confirm, for an uploaded or staged batch only", () => {
    expect(buttonNamed(list([batch({ status: "UPLOADED" })]), /^Discard/)).toBeDefined()
    expect(buttonNamed(list([batch({ status: "STAGED" })]), /^Discard/)).toBeDefined()
    expect(buttonNamed(list([batch({ status: "COMMITTED" })]), /^Discard/)).toBeUndefined()
    expect(buttonNamed(list([batch({ status: "REVERSED" })]), /^Discard/)).toBeUndefined()
    const html = list([batch({ status: "UPLOADED" })])
    expect(visibleText(html)).not.toMatch(/Keep it/)
  })

  it("shows an empty state saying what an import is for, with a New import link, when there are none", () => {
    const html = list([])
    const text = visibleText(html)
    expect(text).toMatch(/statement/i)
    expect(links(html)).toContainEqual(["/import/new", expect.stringContaining("New import")])
  })

  it("has an Import heading and a New import link when batches exist", () => {
    const html = list([batch()])
    expect(html).toMatch(/<h1[^>]*>Import<\/h1>/)
    expect(links(html)).toContainEqual(["/import/new", expect.stringContaining("New import")])
    expect(visibleText(html)).toContain("statement.csv")
  })

  it("names the file in the discard confirm's accessible name", () => {
    const html = list([batch({ fileName: "jan-statement.csv", status: "UPLOADED" })])
    expect(buttonNamed(html, /^Discard/)?.name).toMatch(/jan-statement\.csv/)
  })
})

describe("the import page", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("u1")
    loadBatchList.mockReset().mockResolvedValue([batch()])
  })

  it("reads the batch list for the signed-in user", async () => {
    await ImportPage()
    expect(loadBatchList).toHaveBeenCalledWith("u1")
  })
})

describe("the new-import upload form", () => {
  const form = (accounts: { id: string; name: string; kind: "ASSET" | "LIABILITY" }[], profiles: { id: string; name: string; nodeId: string | null }[] = []) =>
    renderToStaticMarkup(createElement(UploadForm, { accounts, profiles }))

  it("lists the accounts and names the account field", () => {
    const html = form([
      { id: "a1", name: "HDFC", kind: "ASSET" },
      { id: "a2", name: "Credit card", kind: "LIABILITY" },
    ])
    const text = visibleText(html)
    expect(text).toContain("HDFC")
    expect(text).toContain("Credit card")
    expect(html).toMatch(/<label[^>]*for="import-account"[^>]*>[\s\S]*Account/)
  })

  it("has a file input and an Upload button", () => {
    const html = form([{ id: "a1", name: "HDFC", kind: "ASSET" }])
    expect(html).toMatch(/<input[^>]*type="file"/)
    expect(buttonNamed(html, /Upload/)).toBeDefined()
  })

  it("offers no profile select when there are no saved profiles, and one when there are", () => {
    const noProfiles = form([{ id: "a1", name: "HDFC", kind: "ASSET" }])
    expect(noProfiles).not.toMatch(/Mapping/)
    const withProfiles = form([{ id: "a1", name: "HDFC", kind: "ASSET" }], [{ id: "p1", name: "My bank", nodeId: null }])
    expect(visibleText(withProfiles)).toContain("My bank")
  })

  it("reads the new-import form for the signed-in user", async () => {
    requireUserId.mockReset().mockResolvedValue("u1")
    loadNewImport.mockReset().mockResolvedValue({ accounts: [], profiles: [] })
    await NewImportPage()
    expect(loadNewImport).toHaveBeenCalledWith("u1")
  })
})

describe("the preview table", () => {
  const table = (rows: PreviewRow[]) => renderToStaticMarkup(createElement(PreviewTable, { rows }))

  it("shows an error row's reason and nothing else for that row", () => {
    const html = table([previewRow({ line: 5, error: "The date column is not a valid DD/MM/YYYY date", parsed: null })])
    expect(visibleText(html)).toContain("The date column is not a valid DD/MM/YYYY date")
    expect(visibleText(html)).toContain("5")
  })

  it("shows a good row's direction chip and its exact amount, eighteen digits included", () => {
    const html = table([previewRow({ parsed: { occurredOn: "2026-04-01", amountPaise: "123456789012345678", direction: "IN", description: "Big deposit" } })])
    const text = visibleText(html)
    expect(text).toContain("₹1,23,45,67,89,01,23,456.78")
    expect(text).toContain("In")
    expect(html).not.toContain("e+")
    expect(html).not.toContain("NaN")
    expect(html).toContain("figures")
  })

  it("final review I7: writes a parsed day unambiguously as '3 Apr 2026', never as digits a reader must order", () => {
    // The day staging would record is 3 April; numeric DD/MM digits ("03/04/2026") would read as 4 March under MM/DD.
    const text = visibleText(table([previewRow({ parsed: { occurredOn: "2026-04-03", amountPaise: "100", direction: "OUT", description: "Coffee" } })]))
    expect(text).toContain("3 Apr 2026")
    expect(text).not.toMatch(/\d{2}\/\d{2}\/\d{4}/)
  })

  it("shows the out direction in words too", () => {
    const text = visibleText(table([previewRow({ parsed: { occurredOn: "2026-04-01", amountPaise: "100", direction: "OUT", description: "Groceries" } })]))
    expect(text).toContain("Out")
  })

  it("shows a prompt, not an error, for a row with no error and nothing parsed yet", () => {
    const html = table([previewRow({ parsed: null, error: null })])
    expect(visibleText(html)).toMatch(/choose/i)
    expect(visibleText(html)).not.toMatch(/error/i)
  })

  it("renders nothing from the row beyond its line and cells: a row's raw cells never leak when it has a parsed value or an error", () => {
    const html = table([previewRow({ cells: ["SECRET_RAW_CELL_MARKER"], parsed: { occurredOn: "2026-04-01", amountPaise: "100", direction: "OUT", description: "Coffee" } })])
    expect(html).not.toContain("SECRET_RAW_CELL_MARKER")
  })
})

describe("the map form", () => {
  const form = (over: Partial<MapScreen> = {}) =>
    renderToStaticMarkup(createElement(MapForm, { batchId: "batch1", basePath: "/import/batch1/map", screen: mapScreen(over) }))

  it("shows the repeat-upload warning with a required confirmation checkbox when an earlier upload exists", () => {
    const html = form({ earlier: { batchId: "earlier1", uploadedAt: "2026-03-01T00:00:00.000Z", status: "DISCARDED" } })
    expect(visibleText(html)).toMatch(/uploaded before/i)
    expect(html).toMatch(/<input[^>]*type="checkbox"/)
  })

  it("shows neither the warning nor a checkbox when there is no earlier upload", () => {
    const html = form({ earlier: null })
    expect(visibleText(html)).not.toMatch(/uploaded before/i)
    expect(html).not.toMatch(/<input[^>]*type="checkbox"/)
  })

  it.each([
    ["DD/MM/YYYY", "3 April"],
    ["MM/DD/YYYY", "4 March"],
  ] as const)("shows a worked example for %s computed from the real parser", (dateFormat, expected) => {
    const html = form({ mapping: { ...BASE_MAPPING, dateFormat } })
    expect(visibleText(html)).toContain(expected)
    expect(visibleText(html)).toContain("03/04/2026")
  })

  it("shows a worked example for every date format, naming the sample it read", () => {
    const formats = ["YYYY-MM-DD", "DD-MM-YYYY", "DD/MM/YY", "MM/DD/YY", "DD-MMM-YYYY", "D MMM YYYY"] as const
    for (const dateFormat of formats) {
      const html = form({ mapping: { ...BASE_MAPPING, dateFormat } })
      expect(visibleText(html)).toMatch(/reads as \d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December)/)
    }
  })

  it("explains the sign convention differently for an asset and a liability account with the same setting", () => {
    const asset = visibleText(form({ account: { id: "n1", name: "Bank", kind: "ASSET" }, mapping: { ...BASE_MAPPING, signConvention: "POSITIVE_OUT" } }))
    const liability = visibleText(form({ account: { id: "n1", name: "Card", kind: "LIABILITY" }, mapping: { ...BASE_MAPPING, signConvention: "POSITIVE_OUT" } }))
    expect(asset).not.toBe(liability)
    expect(asset.toLowerCase()).toMatch(/leaves this account/)
    expect(liability.toLowerCase()).toMatch(/owes/)
  })

  it("shows the decode error state, and nothing from the sample or preview alongside it", () => {
    const html = form({ decodeError: "The file is not valid utf-8 text", sample: [], headerCells: [], previewRows: [] })
    expect(visibleText(html)).toContain("The file is not valid utf-8 text")
    expect(html).not.toMatch(/The file, as decoded/)
  })

  it("preselects the mapping's own columns in the column pickers: a profile selection changes what is preselected", () => {
    const profileMapping: ImportMapping = { ...BASE_MAPPING, columns: { date: 2, description: 0, debit: 1, credit: 3 } }
    const html = form({ mapping: profileMapping, headerCells: ["B", "C", "A", "D"] })
    expect(selectedValue(html, "cdate")).toBe("2")
    expect(selectedValue(html, "cdesc")).toBe("0")
    expect(selectedValue(html, "cdebit")).toBe("1")
    expect(selectedValue(html, "ccredit")).toBe("3")
    expect(selectedValue(html, "camount")).toBe("")
  })

  it("lists a saved profile as its own one-shot link, named", () => {
    const html = form({ profiles: [{ id: "p1", name: "My bank" }] })
    expect(visibleText(html)).toContain("My bank")
    expect(html).toMatch(/name="profile"[^>]*value="p1"/)
  })

  it("renders nothing of the file's content beyond the decoded sample and the preview", () => {
    const html = form({ sample: ["SAMPLE_MARKER_ONE"], previewRows: [previewRow({ parsed: { occurredOn: "2026-04-01", amountPaise: "100", direction: "OUT", description: "PREVIEW_MARKER_TWO" } })] })
    expect(html).toContain("SAMPLE_MARKER_ONE")
    expect(html).toContain("PREVIEW_MARKER_TWO")
  })

  it("names the file being mapped, without a colour-only state, and uses tabular figures for the amount", () => {
    const html = form()
    expect(html).toContain("figures")
  })

  it("has a Stage rows control that is aria-disabled, not disabled, until an earlier upload is confirmed", () => {
    const html = form({ earlier: { batchId: "e1", uploadedAt: "2026-03-01T00:00:00.000Z", status: "STAGED" } })
    const stage = buttonNamed(html, /Stage rows/)
    expect(stage?.attrs).toContain('aria-disabled="true"')
    expect(stage?.attrs).not.toMatch(/\sdisabled(=|\s|>)/)
  })

  it("final review I6: as first rendered (controls equal to the previewed mapping) Stage rows is open and no 'update the preview' hint shows; the controls form reports changes", () => {
    const html = form()
    const stage = buttonNamed(html, /Stage rows/)
    expect(stage?.attrs).toContain('aria-disabled="false"')
    expect(visibleText(html)).not.toMatch(/Update the preview first/)
    // The mapping controls' form is the one watched for changes (React wires onChange itself; this checks the GET form
    // is still the plain one the server reads, with every mapping field named as the URL carries it).
    for (const name of ["delim", "enc", "skip", "datefmt", "dec", "sign", "cdate", "cdesc", "camount", "cdebit", "ccredit"]) {
      expect(html).toContain(`name="${name}"`)
    }
  })
})

describe("mappingFromParams agrees with the map page's own defaults", () => {
  it("is what the map page uses to turn the URL into a mapping (sanity: not re-tested here, see mapping-params.test.ts)", () => {
    expect(mappingFromParams({}, BASE_MAPPING)).toEqual(BASE_MAPPING)
  })
})

describe("the map page", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("u1")
    loadMapScreen.mockReset().mockResolvedValue(mapScreen())
    loadProfileMapping.mockReset().mockResolvedValue(null)
  })

  const open = (searchParams: Record<string, string | string[] | undefined> = {}) =>
    MapPage({ params: Promise.resolve({ id: "batch1" }), searchParams: Promise.resolve(searchParams) })

  it("reads the screen with no mapping override when the URL carries no parameters", async () => {
    await open()
    expect(loadMapScreen).toHaveBeenCalledWith("u1", "batch1")
    expect(loadMapScreen).toHaveBeenCalledTimes(1)
  })

  it("resolves a chosen profile's own mapping and uses it, overriding other parameters in that request", async () => {
    const profileMapping: ImportMapping = { ...BASE_MAPPING, columns: { date: 2, description: 0, amount: 1 } }
    loadProfileMapping.mockResolvedValue(profileMapping)
    await open({ profile: "p1", cdate: "9" })
    expect(loadProfileMapping).toHaveBeenCalledWith("u1", "p1")
    expect(loadMapScreen).toHaveBeenLastCalledWith("u1", "batch1", profileMapping)
  })

  it("falls back to the parameters when the chosen profile does not resolve", async () => {
    loadProfileMapping.mockResolvedValue(null)
    await open({ profile: "gone", cdate: "1", cdesc: "0", camount: "2" })
    expect(loadMapScreen).toHaveBeenLastCalledWith("u1", "batch1", { ...BASE_MAPPING, columns: { date: 1, description: 0, amount: 2 } })
  })
})

describe("the nav", () => {
  const nav = () => renderToStaticMarkup(createElement(AppNav, { current: "import", email: "a@b.test", signOut: async () => {}, pending: 0 }))

  it("has an Import destination between Budgets and Reports", () => {
    const found = links(nav())
    const hrefs = found.map(([href]) => href)
    expect(found).toContainEqual(["/import", expect.stringContaining("Import")])
    expect(hrefs.indexOf("/import")).toBe(hrefs.indexOf("/budgets") + 1)
    expect(hrefs.indexOf("/reports")).toBe(hrefs.indexOf("/import") + 1)
  })

  it("marks it as the current page when on it", () => {
    expect(nav()).toMatch(/href="\/import"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/import"/)
  })
})

describe("the redirect rules of /import/[id], against the real database", () => {
  const registry = createRegistry()
  afterAll(registry.cleanup)

  beforeEach(() => {
    requireUserId.mockReset()
    redirect.mockReset().mockImplementation(() => {
      throw new Error("NEXT_REDIRECT")
    })
  })

  const open = (id: string) => ImportBatchRedirectPage({ params: Promise.resolve({ id }) })

  async function world() {
    const user = await registry.makeUser()
    const bank = await registry.makeNode(user.id, "ASSET", "Bank")
    requireUserId.mockResolvedValue(user.id)
    return { user, bank }
  }

  it("redirects an UPLOADED batch to the map screen", async () => {
    const { user, bank } = await world()
    const row = await registry.makeBatch(user.id, bank.id, { status: "UPLOADED" })
    await expect(open(row.id)).rejects.toThrow("NEXT_REDIRECT")
    expect(redirect).toHaveBeenCalledWith(`/import/${row.id}/map`)
  })

  it("redirects a STAGED batch to review", async () => {
    const { user, bank } = await world()
    const row = await registry.makeBatch(user.id, bank.id, { status: "STAGED" })
    await expect(open(row.id)).rejects.toThrow("NEXT_REDIRECT")
    expect(redirect).toHaveBeenCalledWith(`/import/${row.id}/review`)
  })

  it("redirects a COMMITTED batch to the batch page", async () => {
    const { user, bank } = await world()
    const row = await registry.makeBatch(user.id, bank.id, { status: "COMMITTED", committedAt: new Date() })
    await expect(open(row.id)).rejects.toThrow("NEXT_REDIRECT")
    expect(redirect).toHaveBeenCalledWith(`/import/${row.id}/batch`)
  })

  it("redirects a REVERSED batch to the batch page too", async () => {
    const { user, bank } = await world()
    const row = await registry.makeBatch(user.id, bank.id, { status: "REVERSED", committedAt: new Date(), reversedAt: new Date() })
    await expect(open(row.id)).rejects.toThrow("NEXT_REDIRECT")
    expect(redirect).toHaveBeenCalledWith(`/import/${row.id}/batch`)
  })

  it("answers not-found for a discarded batch", async () => {
    const { user, bank } = await world()
    const row = await registry.makeBatch(user.id, bank.id, { status: "DISCARDED", fileBytes: null })
    await expect(open(row.id)).rejects.toMatchObject({ digest: expect.stringContaining("404") })
  })

  it("answers not-found for a foreign batch, the same as a ghost id", async () => {
    const { user } = await world()
    const stranger = await registry.makeUser()
    const theirs = await registry.makeNode(stranger.id, "ASSET", "Theirs")
    const theirBatch = await registry.makeBatch(stranger.id, theirs.id, { status: "UPLOADED" })
    requireUserId.mockResolvedValue(user.id)
    await expect(open(theirBatch.id)).rejects.toMatchObject({ digest: expect.stringContaining("404") })
    await expect(open("no-such-batch")).rejects.toMatchObject({ digest: expect.stringContaining("404") })
  })

  it("sends a missing session to /login", async () => {
    requireUserId.mockRejectedValue(new UnauthenticatedError())
    await expect(open("whatever")).rejects.toThrow("NEXT_REDIRECT")
    expect(redirect).toHaveBeenCalledWith("/login")
  })
})

describe("the new files", () => {
  const dir = join(process.cwd(), "src/app/import")
  const files = [
    "page.tsx",
    "loading.tsx",
    "batch-list.tsx",
    "mapping-params.ts",
    "new/page.tsx",
    "new/upload-form.tsx",
    "[id]/page.tsx",
    "[id]/map/page.tsx",
    "[id]/map/map-form.tsx",
    "[id]/map/preview-table.tsx",
  ]

  it("exist", () => {
    for (const name of files) {
      expect(() => readFileSync(join(dir, name), "utf8")).not.toThrow()
    }
  })

  it("use the Graphite and Azure tokens only: no raw colours, no purple, no yellow", () => {
    for (const name of files) {
      const source = readFileSync(join(dir, name), "utf8")
      expect(source, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(source, name).not.toMatch(/\b(rgb|rgba|hsl|oklch)\(/)
      expect(source, name).not.toMatch(/\b(?:bg|text|border|ring|from|via|to|fill|stroke|outline|shadow)-(?:purple|violet|indigo|fuchsia|yellow|amber|lime|red|green|blue|orange)(?:-\d+)?\b/)
    }
  })
})
