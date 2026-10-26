import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { AccountSummary } from "@/app/account-summary"
import { NetWorthCard } from "@/app/net-worth-card"
import type { DashboardView } from "@/lib/dashboard-view"

// What the dashboard says, as markup. The figures are given as paise text, exactly as the server sends them.

const netWorth: DashboardView["netWorth"] = {
  assets: "10099950",
  investments: "1000000",
  liabilities: "124975",
  total: "10974975",
  isPartial: false,
  unvaluedNodeIds: [],
  unvaluedNames: [],
  staleNames: [],
  archivedCount: 0,
}

const card = (over: Partial<DashboardView["netWorth"]> = {}, projected: DashboardView["projected"] = null) =>
  renderToStaticMarkup(createElement(NetWorthCard, { netWorth: { ...netWorth, ...over }, projected }))

// What a reader sees, not how it is built: the figure's rupee sign, digits and paise are styled as separate spans, so the
// markup is split while the text is not. The figure is the card's first paragraph; the browser test reads it the same way.
const visibleText = (html: string) => html.replace(/<[^>]+>/g, "")
const figureOf = (html: string) => visibleText(/<p[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "")

describe("NetWorthCard", () => {
  it("prints the total and its three parts", () => {
    const html = card()
    expect(figureOf(html)).toBe("₹1,09,749.75")
    expect(visibleText(html)).toContain("₹1,00,999.50 in accounts, ₹10,000.00 invested, ₹1,249.75 owed.")
    expect(html).toContain("₹1,00,999.50")
    expect(html).toContain("₹10,000.00")
    expect(html).toContain("₹1,249.75")
  })

  it("does not call a complete figure partial", () => {
    expect(card()).not.toMatch(/partial|incomplete|could not be valued/i)
  })

  it("says the figure is partial, and names what is left out, when an investment cannot be valued", () => {
    const html = card({ isPartial: true, unvaluedNodeIds: ["n1"], unvaluedNames: ["Unpriced fund"] })
    expect(html).toMatch(/partial/i)
    expect(html).toContain("Unpriced fund")
    expect(html).toContain("could not be valued")
  })

  it("shows a negative net worth in red with its sign", () => {
    const html = card({ total: "-24975", assets: "100000", investments: "0", liabilities: "124975" })
    expect(figureOf(html)).toBe("-₹249.75")
    expect(html).toContain("text-negative")
  })

  it("keeps the partial note as it was, and says nothing about stale prices when none is", () => {
    const html = card({ isPartial: true, unvaluedNodeIds: ["n1"], unvaluedNames: ["Unpriced fund"] })
    expect(visibleText(html)).toContain("Partial figure: Unpriced fund could not be valued and is left out of it.")
    expect(card()).not.toMatch(/stale/i)
  })

  it("says which investments are valued at a stale price, by name when there are few (EC-24)", () => {
    expect(visibleText(card({ staleNames: ["Gold"] }))).toContain("Gold is valued at a price more than its stale window old.")
    expect(visibleText(card({ staleNames: ["Gold", "Silver"] }))).toContain("Gold and Silver are valued at prices more than their stale window old.")
    expect(visibleText(card({ staleNames: ["A", "B", "C", "D"] }))).toContain("4 investments are valued at prices more than their stale window old.")
    // Beside the partial note, not instead of it.
    const both = visibleText(card({ isPartial: true, unvaluedNodeIds: ["n1"], unvaluedNames: ["Unpriced fund"], staleNames: ["Gold"] }))
    expect(both).toContain("Partial figure: Unpriced fund could not be valued")
    expect(both).toContain("Gold is valued at a price more than its stale window old.")
  })

  it("marks a projection that leaves out an unvalued investment as partial", () => {
    expect(visibleText(card({}, { total: "8774925", asOf: calendarDate("2099-01-01"), isPartial: true }))).toContain(
      "Projected ₹87,749.25 (partial) once everything dated up to 1 Jan 2099 has happened",
    )
    expect(visibleText(card({}, { total: "8774925", asOf: calendarDate("2099-01-01"), isPartial: false }))).not.toContain("(partial)")
  })

  it("mentions archived accounts that are counted but not listed", () => {
    expect(card({ archivedCount: 2 })).toContain("Includes 2 archived")
  })

  it("shows what the figure will be once future-dated entries land, when there are any", () => {
    const html = card({}, { total: "8774925", asOf: calendarDate("2099-01-01"), isPartial: false })
    expect(html).toContain("₹87,749.25")
    expect(html).toContain("1 Jan 2099")
    expect(html).toMatch(/projected/i)
    expect(card()).not.toMatch(/projected/i)
  })
})

describe("AccountSummary", () => {
  const accounts: DashboardView["accounts"] = [
    { id: "a", name: "HDFC Savings", kind: "ASSET", balance: "9599950", notValued: null, priced: null },
    { id: "g", name: "Gold", kind: "INVESTMENT", balance: "11700000", notValued: null, priced: { asOf: calendarDate("2026-03-01"), stale: true } },
    { id: "p", name: "Plot", kind: "INVESTMENT", balance: "450000000", notValued: null, priced: { asOf: calendarDate("2026-10-20"), stale: false } },
    { id: "s", name: "Silver", kind: "INVESTMENT", balance: "0", notValued: "NO_PRICE", priced: null },
    { id: "c", name: "Axis card", kind: "LIABILITY", balance: "-124975", notValued: null, priced: null },
  ]
  const kindTotals: DashboardView["kindTotals"] = [
    { kind: "ASSET", total: "9599950", archivedCount: 0, unvaluedCount: 0, archivedUnvaluedCount: 0 },
    { kind: "INVESTMENT", total: "461700000", archivedCount: 0, unvaluedCount: 1, archivedUnvaluedCount: 0 },
    { kind: "LIABILITY", total: "-124975", archivedCount: 1, unvaluedCount: 0, archivedUnvaluedCount: 0 },
  ]
  const html = renderToStaticMarkup(createElement(AccountSummary, { accounts, kindTotals }))
  const tileOf = (name: string) => visibleText(new RegExp(`<li[^>]*>(?:(?!</li>)[\\s\\S])*?${name}[\\s\\S]*?</li>`).exec(html)?.[0] ?? "")

  it("prints an investment that cannot be valued as not valued, never as a figure (EC-23)", () => {
    expect(tileOf("Silver")).toContain("Not valued")
    expect(tileOf("Silver")).not.toContain("₹")
    expect(tileOf("Gold")).toContain("₹1,17,000.00")
    expect(tileOf("Gold")).not.toContain("Not valued")
  })

  it("dates the price behind an investment's value, and labels a stale one (EC-24)", () => {
    expect(tileOf("Gold")).toContain("as of 1 Mar 2026")
    expect(tileOf("Gold")).toContain("Stale")
    expect(tileOf("Plot")).toContain("as of 20 Oct 2026")
    expect(tileOf("Plot")).not.toContain("Stale")
    expect(tileOf("HDFC Savings")).not.toContain("as of")
  })

  it("groups the accounts by kind and prints a card you owe on as a positive amount owed, once", () => {
    expect(html).toContain("HDFC Savings")
    expect(html).toContain("₹95,999.50")
    expect(html).toContain("Axis card")
    expect(html).toContain("₹1,249.75")
    expect(html).toContain("owed")
    expect(html).not.toContain("-₹1,249.75")
  })

  it("says that the total of a kind includes archived accounts that are not listed", () => {
    expect(html).toContain("Includes 1 archived, not listed")
  })

  // The section of a kind, from its heading to the end of the section.
  const sectionOf = (markup: string, kind: string) => /<section[^>]*>[\s\S]*?<\/section>/g.exec(markup.slice(markup.indexOf(`id="summary-${kind}"`) - 200))?.[0] ?? ""

  it("says beside the Investments total how many investments it leaves out, not valued, in an element of its own", () => {
    const investments = sectionOf(html, "INVESTMENT")
    expect(investments).toMatch(/<span[^>]*>excludes 1 not valued<\/span>/)
    expect(visibleText(investments)).toContain("₹46,17,000.00") // the figure keeps its own element and text
    expect(sectionOf(html, "ASSET")).not.toContain("not valued")
  })

  it("never says an archived investment that is not valued is included in the total", () => {
    const markup = renderToStaticMarkup(
      createElement(AccountSummary, {
        accounts: accounts.filter((account) => account.kind === "INVESTMENT"),
        kindTotals: [{ kind: "INVESTMENT", total: "461700000", archivedCount: 2, unvaluedCount: 2, archivedUnvaluedCount: 1 }],
      }),
    )
    const text = visibleText(markup)
    expect(text).toContain("excludes 2 not valued")
    expect(text).toContain("2 archived, not listed; 1 of them is not valued and not counted.")
    expect(text).not.toContain("Includes 2 archived")
  })
})
