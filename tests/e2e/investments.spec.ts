import type { Page } from "@playwright/test"
import { prisma } from "@/server/db"
import { expect, test } from "./fixtures"
import { account, buy, investment, nodeId, post, price } from "./seed"
import { balanceOf, entries } from "./screens"

// The investments screen (spec §8.2): the portfolio, one card per investment, its lots on demand, and selling through
// the Sell / redeem form. Prices are put in with the seed helper; entering them on screen is the price screen's spec.
// The figures are the spec's M2 acceptance row: 10 g for ₹70,000 and 5 g for ₹37,000, priced at ₹7,800 a gram.

const card = (page: Page, name: string) => page.getByRole("region", { name, exact: true })
const portfolio = (page: Page) => page.getByRole("region", { name: "Portfolio", exact: true })
const sellForm = (page: Page, name: string) => page.getByRole("form", { name: `Sell ${name}` })
/** One figure of the portfolio card, by its label ("Current value", "Put in", "Unrealised gain"). */
const heroFigure = (page: Page, label: string) =>
  portfolio(page).locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]")

/** Open the investments screen and wait for the real page, not its loading skeleton. */
async function openInvestments(page: Page) {
  await page.goto("/investments")
  await expect(page.getByRole("heading", { level: 1, name: "Investments" })).toBeVisible()
}

async function openTransactions(page: Page, query = "") {
  await page.goto(`/transactions${query}`)
  await expect(page.getByRole("heading", { level: 1, name: "Transactions" })).toBeVisible()
}

/** Expand a card's holding (quantity, cost, lots) if it is not already open. */
async function openHolding(page: Page, name: string) {
  const target = card(page, name)
  const toggle = target.getByRole("button", { name: "Holding" })
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  return target
}

async function openSell(page: Page, name: string) {
  await card(page, name).getByRole("button", { name: "Sell / redeem" }).click()
  await expect(sellForm(page, name)).toBeVisible()
  return sellForm(page, name)
}

test("values gold, sells part of it at a gain, refuses what cannot be done, and unwinds the sale", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "2,00,000")
  await investment(userId, "Gold", { unit: "g" })
  await buy(userId, "Bank", "Gold", "70,000", "10", "2026-01-10")
  await buy(userId, "Bank", "Gold", "37,000", "5", "2026-02-01")
  await investment(userId, "Silver", { unit: "kg" })
  await buy(userId, "Bank", "Silver", "24,000", "0.25", "2026-02-10") // never priced in this test

  // No price yet: the card says so, and never shows a figure for the value.
  await openInvestments(page)
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Investments" })).toHaveAttribute("aria-current", "page")
  const gold = card(page, "Gold")
  await expect(gold.getByRole("heading", { level: 2, name: "Gold" })).toBeVisible()
  await expect(gold).toContainText("Not valued")
  await expect(gold).toContainText("No price yet")
  await expect(gold.getByRole("link", { name: "Record a price" })).toHaveAttribute("href", "/investments/prices")
  await expect(gold).not.toContainText("₹1,17,000.00")
  // Nothing can be valued, so the portfolio has no figures at all, never ₹0.00; it names what is left out, with what was put in.
  await expect(portfolio(page)).toContainText("2 not valued")
  await expect(heroFigure(page, "Current value")).toHaveText("Not valued")
  await expect(heroFigure(page, "Unrealised gain")).toHaveText("Not valued")
  await expect(heroFigure(page, "Put in")).toHaveCount(0)
  await expect(portfolio(page)).not.toContainText("₹0.00")
  await expect(portfolio(page)).toContainText(
    "Nothing here can be valued yet: Gold (₹1,07,000.00 put in) and Silver (₹24,000.00 put in) are not valued and are left out of these figures.",
  )

  // Priced at ₹7,800 a gram on 1 Mar 2026, a price old enough to be stale by now.
  await price(userId, "Gold", "7,800", "2026-03-01")
  await openInvestments(page)
  await expect(gold).not.toContainText("Not valued")
  await expect(gold).toContainText("₹1,17,000.00")
  await expect(gold).toContainText("+₹10,000.00 (9.35%)")
  await expect(gold).toContainText("₹7,800.00 per g")
  await expect(gold).toContainText("as of 1 Mar 2026")
  await expect(gold.getByText("Stale", { exact: true })).toBeVisible()
  // The three portfolio figures are over the same holdings, Gold alone: worth 1,17,000 less 1,07,000 put in is a 10,000 gain.
  // Silver is named as left out, with its own cost, rather than being counted in one figure and not the others.
  await expect(heroFigure(page, "Current value")).toHaveText("₹1,17,000.00")
  await expect(heroFigure(page, "Put in")).toHaveText("₹1,07,000.00")
  await expect(heroFigure(page, "Unrealised gain")).toHaveText("+₹10,000.00 (9.35%)")
  await expect(portfolio(page)).toContainText("1 not valued")
  await expect(portfolio(page)).toContainText("Silver (₹24,000.00 put in) is not valued and is left out of these figures.")
  await expect(portfolio(page)).toContainText("Gold is valued at a price more than its stale window old.")

  // The holding as a whole, and its lots on demand.
  await openHolding(page, "Gold")
  await expect(gold).toContainText("15 g")
  await expect(gold).toContainText("₹1,07,000.00")
  const lots = gold.getByRole("table", { name: "Lots of Gold" })
  await expect(lots).toHaveCount(0)
  await gold.getByRole("checkbox", { name: "Show lots" }).check()
  await expect(lots.getByRole("row")).toHaveCount(3) // the header and two lots, oldest first
  await expect(lots.getByRole("row").nth(1)).toContainText("10 Jan 2026")
  await expect(lots.getByRole("row").nth(1)).toContainText("₹70,000.00")
  await expect(lots.getByRole("row").nth(2)).toContainText("1 Feb 2026")

  // Sell 8 g for ₹68,000: the form says what it will post before it is sent.
  const sell = await openSell(page, "Gold")
  await sell.getByLabel(/^Quantity/).fill("8")
  await sell.getByLabel("Proceeds (₹)").fill("68,000")
  await sell.getByLabel("Paid into").selectOption({ label: "Bank" })
  await expect(sell.getByText("Cost basis ₹56,000.00 · gain ₹12,000.00")).toBeVisible()
  await sell.getByRole("button", { name: "Sell", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("Sold 8 g of Gold for ₹68,000.00 into Bank.")
  await expect(page.getByRole("status")).toContainText("Cost basis ₹56,000.00 · gain ₹12,000.00")
  await expect(page.getByRole("status")).toBeFocused() // the form that had the focus is gone; the message has it

  // FIFO took 8 g of the first lot: 7 g are left, which cost ₹51,000 (₹14,000 of the first lot and all of the second).
  await expect(sellForm(page, "Gold")).toHaveCount(0)
  await openHolding(page, "Gold")
  await expect(gold).toContainText("7 g")
  await expect(gold).toContainText("₹51,000.00")
  await expect(gold).toContainText("₹54,600.00") // 7 g at ₹7,800
  await gold.getByRole("checkbox", { name: "Show lots" }).check()
  await expect(lots.getByRole("row").nth(1)).toContainText("2 g") // remaining of the first lot's 10 g

  // Selling 8 g more is refused, said once, beside the quantity.
  const again = await openSell(page, "Gold")
  await again.getByLabel(/^Quantity/).fill("8")
  await again.getByLabel("Proceeds (₹)").fill("68,000")
  await again.getByLabel("Paid into").selectOption({ label: "Bank" })
  await expect(again.getByText(/Only 7 g of Gold is available/)).toBeVisible() // the preview says it first
  await again.getByRole("button", { name: "Sell", exact: true }).click()
  await expect(again.getByLabel(/^Quantity/)).toHaveAttribute("aria-invalid", "true")
  await expect(again.getByText(/Only 7 g of Gold is available/)).toHaveCount(1)
  await expect(again.getByRole("alert")).toHaveCount(0)
  // Cancel closes the form and hands the focus back to what opened it.
  await again.getByRole("button", { name: "Cancel" }).click()
  await expect(sellForm(page, "Gold")).toHaveCount(0)
  await expect(gold.getByRole("button", { name: "Sell / redeem" })).toBeFocused()

  // On the transactions screen: the sale is one entry, a cost-basis leg and a Realised Gain leg, both into the bank,
  // whose balance rose by the ₹68,000 (2,00,000 - 70,000 - 37,000 - 24,000 for the silver + 68,000).
  await openTransactions(page)
  await expect(balanceOf(page, "Bank")).toContainText("₹1,37,000.00")
  const sale = entries(page).getByRole("listitem").filter({ hasText: "Split from several sources" })
  await expect(sale).toContainText("₹68,000.00")
  await sale.getByRole("button", { expanded: false }).first().click()
  const legs = sale.getByRole("list", { name: "Legs" })
  await expect(legs.getByRole("listitem").filter({ hasText: "Gold → Bank" })).toContainText("₹56,000.00")
  await expect(legs.getByRole("listitem").filter({ hasText: "Realised Gain → Bank" })).toContainText("₹12,000.00")

  // The first purchase cannot go while a sale takes from it.
  await openTransactions(page, "?from=&to=")
  const first = entries(page).getByRole("listitem").filter({ hasText: "Bank → Gold" }).filter({ hasText: "₹70,000.00" })
  await first.getByRole("button", { expanded: false }).first().click()
  await first.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(first.getByRole("alert")).toContainText("Delete the sale first")

  // Deleting the sale gives the 8 g back to the first lot, and the money back out of the bank.
  const sold = entries(page).getByRole("listitem").filter({ hasText: "Split from several sources" })
  await sold.getByRole("button", { expanded: false }).first().click()
  await sold.getByRole("button", { name: "Delete split" }).click()
  await expect(page.getByRole("status")).toContainText("Deleted the split")
  await expect(balanceOf(page, "Bank")).toContainText("₹69,000.00")

  await openInvestments(page)
  await openHolding(page, "Gold")
  await expect(gold).toContainText("15 g")
  await expect(gold).toContainText("₹1,07,000.00")
  await expect(gold).toContainText("₹1,17,000.00")
})

test("a lump is sold whole, a contribution-only investment has nothing to sell, and missing quantities leave it unvalued", async ({
  session: { page, userId },
}) => {
  await account(userId, "Bank", "60,00,000")
  await investment(userId, "Flat", { valuation: "LUMP", unit: "flat" })
  await post(userId, "Bank", "Flat", "50,00,000", { date: "2026-01-15" })
  await price(userId, "Flat", "52,00,000", "2026-03-01")
  await investment(userId, "PPF", { valuation: "CONTRIBUTION_ONLY", unit: "unit" })
  await post(userId, "Bank", "PPF", "1,50,000", { date: "2026-01-20" })
  // An investment that held money before it was valued by quantity: its entry has no quantity, so it has no holding.
  await investment(userId, "Old fund", { valuation: "CONTRIBUTION_ONLY", unit: "unit" })
  await post(userId, "Bank", "Old fund", "20,000", { date: "2026-01-05" })
  await prisma.ledgerNode.update({ where: { id: await nodeId(userId, "Old fund") }, data: { valuationMode: "QUANTITY", lotMethod: "FIFO" } })

  await openInvestments(page)

  const ppf = card(page, "PPF")
  await expect(ppf).toContainText("Not revalued")
  await expect(ppf).toContainText("₹1,50,000.00")
  await expect(ppf.getByRole("button", { name: "Sell / redeem" })).toHaveCount(0)
  await expect(ppf.getByRole("button", { name: "Holding" })).toHaveCount(0)
  await expect(ppf.getByRole("link", { name: "Transactions" })).toBeVisible()

  const old = card(page, "Old fund")
  await expect(old).toContainText("Not valued")
  await expect(old).toContainText("Some purchases have no quantity")
  await expect(old).not.toContainText("₹") // no figure at all: not even what it cost, which is not known
  // The portfolio's figures are the Flat's alone: the PPF is valued by what was put in, and the old fund's cost is not known.
  await expect(portfolio(page)).toContainText("1 not valued")
  await expect(heroFigure(page, "Current value")).toHaveText("₹52,00,000.00")
  await expect(heroFigure(page, "Put in")).toHaveText("₹50,00,000.00")
  await expect(heroFigure(page, "Unrealised gain")).toHaveText("+₹2,00,000.00 (4.00%)")
  await expect(portfolio(page)).toContainText("Old fund (its cost is not known) is not valued and is left out of these figures.")
  await expect(portfolio(page)).toContainText("PPF is valued by what was put in, so not counted here")

  // A lump has no quantity to choose: the form sells the whole of it. Selling below cost is a loss, said as one.
  const flat = card(page, "Flat")
  await expect(flat).toContainText("₹52,00,000.00")
  await expect(flat).toContainText("+₹2,00,000.00 (4.00%)")
  const sell = await openSell(page, "Flat")
  await expect(sell.getByLabel(/^Quantity/)).toHaveCount(0)
  await expect(sell).toContainText("Sells the whole of Flat")
  await sell.getByLabel("Proceeds (₹)").fill("45,00,000")
  await sell.getByLabel("Paid into").selectOption({ label: "Bank" })
  await expect(sell.getByText("Cost basis ₹50,00,000.00 · loss ₹5,00,000.00")).toBeVisible()
  await sell.getByRole("button", { name: "Sell", exact: true }).click()
  await expect(page.getByRole("status")).toContainText("Sold Flat for ₹45,00,000.00 into Bank.")
  await expect(page.getByRole("status")).toContainText("Cost basis ₹50,00,000.00 · loss ₹5,00,000.00")
  await expect(flat).toContainText("Nothing held")
  await expect(flat.getByRole("button", { name: "Sell / redeem" })).toHaveCount(0)
})
