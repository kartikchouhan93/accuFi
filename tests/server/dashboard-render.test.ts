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

  it("mentions archived accounts that are counted but not listed", () => {
    expect(card({ archivedCount: 2 })).toContain("Includes 2 archived")
  })

  it("shows what the figure will be once future-dated entries land, when there are any", () => {
    const html = card({}, { total: "8774925", asOf: calendarDate("2099-01-01") })
    expect(html).toContain("₹87,749.25")
    expect(html).toContain("1 Jan 2099")
    expect(html).toMatch(/projected/i)
    expect(card()).not.toMatch(/projected/i)
  })
})

describe("AccountSummary", () => {
  const accounts: DashboardView["accounts"] = [
    { id: "a", name: "HDFC Savings", kind: "ASSET", balance: "9599950", notValued: null },
    { id: "g", name: "Gold", kind: "INVESTMENT", balance: "11700000", notValued: null },
    { id: "s", name: "Silver", kind: "INVESTMENT", balance: "0", notValued: "NO_PRICE" },
    { id: "c", name: "Axis card", kind: "LIABILITY", balance: "-124975", notValued: null },
  ]
  const kindTotals: DashboardView["kindTotals"] = [
    { kind: "ASSET", total: "9599950", archivedCount: 0 },
    { kind: "INVESTMENT", total: "11700000", archivedCount: 0 },
    { kind: "LIABILITY", total: "-124975", archivedCount: 1 },
  ]
  const html = renderToStaticMarkup(createElement(AccountSummary, { accounts, kindTotals }))
  const tileOf = (name: string) => visibleText(new RegExp(`<li[^>]*>(?:(?!</li>)[\\s\\S])*?${name}[\\s\\S]*?</li>`).exec(html)?.[0] ?? "")

  it("prints an investment that cannot be valued as not valued, never as a figure (EC-23)", () => {
    expect(tileOf("Silver")).toContain("Not valued")
    expect(tileOf("Silver")).not.toContain("₹")
    expect(tileOf("Gold")).toContain("₹1,17,000.00")
    expect(tileOf("Gold")).not.toContain("Not valued")
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
})
