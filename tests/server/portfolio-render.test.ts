import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { PortfolioHero } from "@/app/investments/portfolio-hero"
import type { HoldingView, Portfolio } from "@/lib/investment-view"

// What the portfolio card says, as markup, from holdings given as the server sends them.

const holding = (over: Partial<HoldingView>): HoldingView => ({
  nodeId: "n",
  name: "Gold",
  unitLabel: "g",
  valuationMode: "QUANTITY",
  archived: false,
  quantityHeld: "15",
  costBasisPaise: "10700000",
  valuePaise: "11700000",
  unrealisedGainPaise: "1000000",
  gainBasisPoints: 935,
  price: { asOf: calendarDate("2026-03-01"), pricePerUnitPaise: "780000", stale: true },
  notValued: null,
  quantityGaps: [],
  lotMethod: "FIFO",
  lotCount: 2,
  ...over,
})

const visibleText = (html: string) => html.replace(/<[^>]+>/g, "")

const hero = (holdings: HoldingView[]) => {
  const portfolio: Portfolio = {
    holdings,
    totals: { valuedCount: holdings.length, costBasisPaise: "10700000", valuePaise: "11700000", unrealisedGainPaise: "1000000", gainBasisPoints: 935, notValuedCount: 0 },
  }
  return visibleText(renderToStaticMarkup(createElement(PortfolioHero, { portfolio })))
}

describe("PortfolioHero", () => {
  it("names a holding valued at a stale price", () => {
    expect(hero([holding({})])).toContain("Gold is valued at a price more than its stale window old.")
  })

  it("does not name a holding that is fully sold: nothing is valued at its price, stale or not", () => {
    const sold = holding({ name: "Flat", valuationMode: "LUMP", quantityHeld: "0", costBasisPaise: "0", valuePaise: "0", unrealisedGainPaise: "0" })
    const text = hero([holding({ price: { asOf: calendarDate("2026-10-20"), pricePerUnitPaise: "780000", stale: false } }), sold])
    expect(text).not.toContain("Flat is valued")
    expect(text).not.toMatch(/stale window/)
  })
})
