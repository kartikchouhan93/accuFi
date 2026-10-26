import type { Page } from "@playwright/test"
import { formatDay } from "@/lib/transaction-text"
import { prisma } from "@/server/db"
import { expect, test } from "./fixtures"
import { account, buy, investment, nodeId, post, price, today } from "./seed"
import { balanceOf, editForm, entries, form, optionsOf } from "./screens"

// The investments screen (spec §8.2): the portfolio, one card per investment, its lots on demand, and selling through
// the Sell / redeem form. Prices are put in with the seed helper; entering them on screen is the price screen's spec.
// The figures are the spec's M2 acceptance row: 10 g for ₹70,000 and 5 g for ₹37,000, priced at ₹7,800 a gram; the two
// purchases are entered on the transaction form, by quantity.

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
  await investment(userId, "Silver", { unit: "kg" })
  await buy(userId, "Bank", "Silver", "24,000", "0.25", "2026-02-10") // never priced in this test

  // The two purchases of gold, on the transaction form: the first by its amount and quantity (the price per gram is worked
  // out), the second by its quantity and price per gram (the amount is).
  await openTransactions(page)
  const entry = form(page)
  await entry.getByLabel("From", { exact: true }).selectOption({ label: "Bank" })
  await entry.getByLabel("To", { exact: true }).selectOption({ label: "Gold" })
  await entry.getByLabel("Amount (₹)").fill("70,000")
  await entry.getByLabel("Quantity (g)").fill("10")
  await expect(entry.getByLabel("Price per g (₹)")).toHaveValue("7000.00")
  await entry.getByLabel("Date").fill("2026-01-10")
  await entry.getByRole("button", { name: "Record transaction" }).click()
  await expect(page.getByRole("status")).toContainText("Recorded Bank → Gold, ₹70,000.00.")
  await expect(entry.getByLabel("Amount (₹)")).toHaveValue("")
  await entry.getByLabel("To", { exact: true }).selectOption({ label: "Gold" })
  await entry.getByLabel("Quantity (g)").fill("5")
  await entry.getByLabel("Price per g (₹)").fill("7,400")
  await expect(entry.getByLabel("Amount (₹)")).toHaveValue("37000.00")
  await entry.getByLabel("Date").fill("2026-02-01")
  await entry.getByRole("button", { name: "Record transaction" }).click()
  await expect(page.getByRole("status")).toContainText("Recorded Bank → Gold, ₹37,000.00.")

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
  // A sale is deleted and entered again, never edited: its legs offer neither, and the row says so.
  await expect(sale.getByRole("button", { name: /^Edit/ })).toHaveCount(0)
  await expect(sale.getByRole("button", { name: /out of the split$/ })).toHaveCount(0)
  await expect(sale).toContainText("A sale cannot be edited. Delete it and enter it again from the Investments screen.")
  await expect(sale.getByRole("button", { name: "Delete split" })).toBeVisible()

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

  // The old fund's purchase gains its quantity through the transaction's edit form, and a price then values the fund.
  await openTransactions(page, "?from=&to=")
  const purchase = entries(page).getByRole("listitem").filter({ hasText: "Bank → Old fund" })
  await purchase.getByRole("button", { expanded: false }).first().click()
  await purchase.getByRole("button", { name: "Edit" }).click()
  const edit = editForm(page)
  await expect(edit.getByLabel("Quantity (unit)")).toHaveValue("")
  await expect(edit).toContainText("This purchase has no quantity yet.")
  await edit.getByLabel("Quantity (unit)").fill("200")
  await expect(edit.getByLabel("Price per unit (₹)")).toHaveValue("100.00")
  await edit.getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByRole("status")).toContainText("Saved changes to Bank → Old fund, ₹20,000.00")
  await price(userId, "Old fund", "110", "2026-03-01")
  await openInvestments(page)
  await expect(old).not.toContainText("Not valued")
  await expect(old).toContainText("₹22,000.00") // 200 units at ₹110
})

// The price screen (/investments/prices): pick an investment, a day and a price; the form says what the price would do to
// today's value before it is saved; below it, the investment's prices, newest first, each deletable.

const priceForm = (page: Page) => page.getByRole("form", { name: "Record a price" })
const history = (page: Page, name: string) => page.getByRole("region", { name: `Prices of ${name}`, exact: true })

async function openPrices(page: Page) {
  await page.goto("/investments/prices")
  await expect(page.getByRole("heading", { level: 1, name: "Record prices" })).toBeVisible()
}

/** The day after `day`, as "YYYY-MM-DD". */
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

test("records a price after previewing it, refuses a future day, replaces a day, and deleting the only price unvalues it", async ({
  session: { page, userId },
}) => {
  await account(userId, "Bank", "2,00,000")
  await investment(userId, "Gold", { unit: "g" })
  await buy(userId, "Bank", "Gold", "70,000", "10", "2026-01-10")
  await buy(userId, "Bank", "Gold", "37,000", "5", "2026-02-01")
  await investment(userId, "Silver", { unit: "kg" })
  await investment(userId, "PPF", { valuation: "CONTRIBUTION_ONLY", unit: "unit" })
  await post(userId, "Bank", "PPF", "1,50,000", { date: "2026-01-20" })
  const now = await today(userId)

  // The card's "Record a price" link leads to a working screen.
  await openInvestments(page)
  await card(page, "Gold").getByRole("link", { name: "Record a price" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Record prices" })).toBeVisible()
  await expect(page).toHaveURL(/\/investments\/prices$/)
  await expect(page.getByRole("link", { name: /Investments/ }).first()).toBeVisible()

  const form = priceForm(page)
  // Only the investments revalued by a price are offered: the PPF is valued by what was put in.
  expect(await optionsOf(form.getByLabel("Investment"))).toEqual(["Gold", "Silver"])
  await expect(form.getByLabel("Date")).toHaveValue(now)
  await expect(form.getByLabel("Date")).toHaveAttribute("max", now)

  // The price's label follows the investment's unit; choosing one never puts its id in the URL.
  await form.getByLabel("Investment").selectOption({ label: "Silver" })
  await expect(form.getByLabel("Price per kg (₹)")).toBeVisible()
  await form.getByLabel("Investment").selectOption({ label: "Gold" })
  await expect(form.getByLabel("Price per g (₹)")).toBeVisible()
  await expect(page).toHaveURL(/\/investments\/prices$/)
  await expect(history(page, "Gold")).toContainText("No prices yet")

  // Before saving: what the price would make it worth today. Gold had no price, so it was not valued.
  await form.getByLabel("Price per g (₹)").fill("7,800")
  await expect(form.getByText("Not valued yet → ₹1,17,000.00")).toBeVisible()

  // A day after today is refused, beside the Date field: by the preview while typing, and on saving.
  await form.getByLabel("Date").fill(dayAfter(now))
  await expect(form.getByText("A price cannot be dated after today.")).toBeVisible()
  await expect(form.getByText("Not valued yet → ₹1,17,000.00")).toHaveCount(0)
  await form.getByRole("button", { name: "Save price" }).click()
  await expect(form.getByLabel("Date")).toHaveAttribute("aria-invalid", "true")
  await expect(form.getByLabel("Date")).toBeFocused()
  await expect(form.getByText("A price cannot be dated after today.")).toHaveCount(1)
  await expect(form.getByRole("alert")).toHaveCount(0)
  await expect(history(page, "Gold")).toContainText("No prices yet")

  // Saved for 1 Mar 2026: said, with the focus on the message; the history lists it, stale by now.
  await form.getByLabel("Date").fill("2026-03-01")
  await expect(form.getByText("Not valued yet → ₹1,17,000.00")).toBeVisible()
  await form.getByRole("button", { name: "Save price" }).click()
  await expect(page.getByRole("status")).toContainText("Saved ₹7,800.00 per g for 1 Mar 2026.")
  await expect(page.getByRole("status")).toBeFocused()
  await expect(form.getByLabel("Investment")).toHaveValue(await nodeId(userId, "Gold")) // still chosen
  const rows = history(page, "Gold").getByRole("listitem")
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("1 Mar 2026")
  await expect(rows.first()).toContainText("₹7,800.00 per g")
  await expect(rows.first().getByText("Stale", { exact: true })).toBeVisible()

  // Now valued: a rise and a fall are said with their sign, the fall in the negative tone.
  await form.getByLabel("Price per g (₹)").fill("8,000")
  await expect(form.getByText("Value now ₹1,17,000.00 → ₹1,20,000.00 (+₹3,000.00)")).toBeVisible()
  await form.getByLabel("Price per g (₹)").fill("7,500")
  await expect(form.getByText("Value now ₹1,17,000.00 → ₹1,12,500.00 (-₹4,500.00)")).toBeVisible()
  await expect(form.locator(".text-negative", { hasText: "-₹4,500.00" })).toBeVisible() // a fall is in the negative tone

  // Saving the same day again replaces its price: one row, with the second price.
  await form.getByLabel("Price per g (₹)").fill("7,900")
  await expect(form.getByText("Value now ₹1,17,000.00 → ₹1,18,500.00 (+₹1,500.00)")).toBeVisible()
  await form.getByRole("button", { name: "Save price" }).click()
  await expect(page.getByRole("status")).toContainText("Saved ₹7,900.00 per g for 1 Mar 2026: it replaced the price for that day (₹7,800.00 per g).")
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("₹7,900.00 per g")

  await openInvestments(page)
  await expect(card(page, "Gold")).toContainText("₹1,18,500.00")
  await expect(card(page, "Gold")).toContainText("₹7,900.00 per g")

  // Deleting the only price: the focus goes to the message (the row is gone), and the card is not valued again.
  await openPrices(page)
  await priceForm(page).getByLabel("Investment").selectOption({ label: "Gold" })
  await history(page, "Gold").getByRole("button", { name: "Delete the price for 1 Mar 2026" }).click()
  await expect(page.getByRole("status")).toContainText("Deleted the price for 1 Mar 2026 (₹7,900.00 per g).")
  await expect(page.getByRole("status")).toBeFocused()
  await expect(history(page, "Gold")).toContainText("No prices yet")
  await openInvestments(page)
  await expect(card(page, "Gold")).toContainText("Not valued")
  await expect(card(page, "Gold")).toContainText("No price yet")
})

test("an investment missing quantities cannot be valued by a price, and the form works from the keyboard alone", async ({
  session: { page, userId },
}) => {
  await account(userId, "Bank", "60,00,000")
  await investment(userId, "Old fund", { valuation: "CONTRIBUTION_ONLY", unit: "unit" })
  await post(userId, "Bank", "Old fund", "20,000", { date: "2026-01-05" })
  await prisma.ledgerNode.update({ where: { id: await nodeId(userId, "Old fund") }, data: { valuationMode: "QUANTITY", lotMethod: "FIFO" } })
  await investment(userId, "Flat", { valuation: "LUMP", unit: "flat" })
  await post(userId, "Bank", "Flat", "50,00,000", { date: "2026-01-15" })
  await investment(userId, "PPF", { valuation: "CONTRIBUTION_ONLY", unit: "unit" })
  const now = await today(userId)

  await openPrices(page)
  const form = priceForm(page)
  expect(await optionsOf(form.getByLabel("Investment"))).toEqual(["Flat", "Old fund"])

  // No price can value what is held when some purchases have no quantity: said in words, never as a figure.
  await form.getByLabel("Investment").selectOption({ label: "Old fund" })
  await form.getByLabel("Price per unit (₹)").fill("100")
  await expect(form.getByText("Some purchases of this investment have no quantity, so a price cannot value it yet.")).toBeVisible()
  await expect(form.getByText(/→/)).toHaveCount(0)

  // The whole form from the keyboard: choose by typing, move by Tab, save with Enter.
  const select = form.getByLabel("Investment")
  await select.focus()
  await page.keyboard.type("Fl")
  await expect(select).toHaveValue(await nodeId(userId, "Flat"))
  const field = form.getByLabel("Price of the whole (₹)")
  for (let i = 0; i < 6 && !(await field.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab")
  await expect(field).toBeFocused()
  await page.keyboard.type("52,00,000")
  await expect(form.getByText("Not valued yet → ₹52,00,000.00")).toBeVisible()
  await page.keyboard.press("Enter")
  const status = page.getByRole("status")
  await expect(status).toContainText(`Saved ₹52,00,000.00 for ${formatDay(now)}.`)
  await expect(status).toBeFocused()
  // Back from the message to the history's Delete button, delete with Enter, then undo from the message.
  await expect(history(page, "Flat").getByRole("listitem")).toHaveCount(1)
  await page.keyboard.press("Shift+Tab")
  await expect(history(page, "Flat").getByRole("button", { name: `Delete the price for ${formatDay(now)}` })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(status).toContainText(`Deleted the price for ${formatDay(now)} (₹52,00,000.00).`)
  await expect(status).toBeFocused()
  await expect(history(page, "Flat")).toContainText("No prices yet")
  await expect(status.getByRole("button", { name: "Dismiss" })).toHaveCount(1) // the message before it has finished leaving
  await page.keyboard.press("Tab")
  await expect(status.getByRole("button", { name: "Undo" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(status).toContainText(`Put back the price for ${formatDay(now)} (₹52,00,000.00).`)
  await expect(history(page, "Flat").getByRole("listitem")).toHaveCount(1)
})

test("a slow preview answer about an earlier price never replaces the answer about the price typed now", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "1,00,000")
  await investment(userId, "Gold", { unit: "g" })
  await buy(userId, "Bank", "Gold", "70,000", "10", "2026-01-10")

  // The preview of ₹8,000 is held back until well after the preview of ₹9,000 has been answered.
  let releaseSlow: () => void = () => {}
  const slowSent = new Promise<void>((resolve) => {
    void page.route("**/*", async (route) => {
      const request = route.request()
      if (request.method() !== "POST" || !("next-action" in request.headers())) return route.fallback()
      if (!(request.postData() ?? "").includes('"8000"')) return route.fallback()
      resolve()
      await new Promise<void>((release) => (releaseSlow = release))
      return route.fallback()
    })
  })

  await openPrices(page)
  const form = priceForm(page)
  await form.getByLabel("Investment").selectOption({ label: "Gold" })
  await form.getByLabel("Price per g (₹)").fill("8000")
  await slowSent // the debounce has passed and the request for ₹8,000 is out
  // Everything the page ever shows from here on, so a figure shown for an instant is caught too.
  await page.evaluate(() => {
    const seen: string[] = ((window as unknown as { seen: string[] }).seen = [])
    new MutationObserver(() => seen.push(document.body.innerText)).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  await form.getByLabel("Price per g (₹)").fill("9000")
  await page.waitForTimeout(600) // past the debounce: the request for ₹9,000 is sent (Next queues it behind the first)
  releaseSlow()
  await expect(form.getByText("Not valued yet → ₹90,000.00")).toBeVisible()
  await page.waitForTimeout(500)
  await expect(form.getByText("Not valued yet → ₹90,000.00")).toBeVisible()
  const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen)
  expect(seen.some((text) => text.includes("₹80,000.00"))).toBe(false)
})

test("a price typed for one investment is not carried to another when the choice changes", async ({ session: { page, userId } }) => {
  await account(userId, "Bank", "2,00,000")
  await investment(userId, "Gold", { unit: "g" })
  await buy(userId, "Bank", "Gold", "70,000", "10", "2026-01-10")
  await investment(userId, "Silver", { unit: "g" })
  await buy(userId, "Bank", "Silver", "24,000", "250", "2026-02-10")

  await openPrices(page)
  const form = priceForm(page)
  await form.getByLabel("Investment").selectOption({ label: "Gold" })
  await form.getByLabel("Date").fill("2026-03-01")
  await form.getByLabel("Price per g (₹)").fill("7,800")
  await expect(form.getByText("Not valued yet → ₹78,000.00")).toBeVisible()

  // Silver is counted in the same unit, so the field keeps its label: only clearing it stops a gold price being saved for silver.
  await form.getByLabel("Investment").selectOption({ label: "Silver" })
  await expect(form.getByLabel("Price per g (₹)")).toHaveValue("")
  await expect(form.getByLabel("Date")).toHaveValue("2026-03-01")
  await page.waitForTimeout(600) // past the preview's debounce: nothing is asked of the cleared field
  await expect(form.getByText(/→/)).toHaveCount(0)
  await expect(form.getByText("Enter a price to see what it does to the value today.")).toBeVisible()
  await form.getByRole("button", { name: "Save price" }).click()
  await expect(form.getByLabel("Price per g (₹)")).toHaveAttribute("aria-invalid", "true")
  expect(await prisma.priceSnapshot.count({ where: { userId } })).toBe(0)

  // Back on the gold, the price is not brought back either.
  await form.getByLabel("Investment").selectOption({ label: "Gold" })
  await expect(form.getByLabel("Price per g (₹)")).toHaveValue("")
})
