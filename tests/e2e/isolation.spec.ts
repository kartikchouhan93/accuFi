import { randomUUID } from "node:crypto"
import type { Page } from "@playwright/test"
import { addDays, calendarDate } from "@/domain/calendar-date"
import { parseQuantity } from "@/domain/quantity"
import { parseRupees } from "@/domain/money"
import { formatPaiseText } from "@/lib/node-money"
import { prisma } from "@/server/db"
import { sellInvestment } from "@/server/services/investment-service"
import { editTransaction } from "@/server/services/transaction-service"
import { expect, section, test } from "./fixtures"
import { balanceOf, editForm, entries, form, optionsOf, record, watchActions } from "./screens"
import { account, addExpense, buy, card, incomeSource, investment, nodeId, post, price, recurringRule, today } from "./seed"

// Cross-user isolation, proven through a browser. The repository layer is tested exhaustively for it; this is the same
// claim made where a user could actually break it: two people, two sessions, one server. Each test gets user A and user B
// in browser contexts of their own (the `pair` fixture), so a cookie cannot cross, and A's data is made unmistakable:
// every name carries "Zephyr" and the amounts are ones nothing else on a page could be. A leak then shows up whether it
// is drawn on screen or only sent to the page as data, so what is searched is the rendered text AND the page's HTML,
// which carries everything the server handed to its client components.

const VAULT = "Zephyr Vault Savings"
const EMPLOYER = "Zephyr Employer"
const HOBBY = "Zephyr Hobby"
const PLATINUM = "Zephyr Platinum card"

/** A's money, in rupees as typed. Net worth works out to ₹10,99,135.69: 9,87,654.32 + 1,23,456.78 - 7,654.32 - 4,321.09. */
const A_NET_WORTH = "₹10,99,135.69"

async function seedA(userId: string) {
  await account(userId, VAULT, "9,87,654.32")
  await incomeSource(userId, EMPLOYER)
  await addExpense(userId, HOBBY)
  await card(userId, PLATINUM, { owed: "4,321.09" })
  await post(userId, EMPLOYER, VAULT, "1,23,456.78", { note: "Zephyr signing bonus" })
  const kayak = await post(userId, VAULT, HOBBY, "7,654.32", { note: "Zephyr kayak" })
  // Edited once, so A's row is at a later version than B's untouched rows: a lookup that checked the version before it
  // checked the owner would answer B with a conflict carrying A's row.
  return editTransaction(userId, kayak.id, { note: "Zephyr kayak, paid" }, kayak.version)
}

/** B's ledger: ₹1,000 in a wallet and a ₹250 bus pass out of it, so net worth is ₹750.00. */
async function seedB(userId: string) {
  await account(userId, "Plain Wallet", "1,000")
  return post(userId, "Plain Wallet", "Transport", "250", { note: "Bus pass" })
}

/** Every string that identifies A: names, amounts as printed and as paise, and the ids a request could carry. */
async function secretsOfA(userId: string): Promise<string[]> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  const nodes = await prisma.ledgerNode.findMany({ where: { userId } })
  const transactions = await prisma.transaction.findMany({ where: { userId } })
  return [
    "Zephyr",
    user.email,
    userId,
    ...nodes.map((node) => node.id),
    ...transactions.map((transaction) => transaction.id),
    ...["9,87,654.32", "98765432", "1,23,456.78", "12345678", "7,654.32", "765432", "4,321.09", "432109", "10,99,135.69", "109913569"],
  ]
}

/**
 * Whether `secret` is in `where`: plain text and ids by substring, figures by exactly the number they are.
 *  - Digits only ("98765432", paise): not part of a longer run of digits. A comma, quote or bracket beside it is fine, so
 *    `[98765432,12345678]` and `{"a":98765432}` are found.
 *  - A figure with a "." or "," in it ("9.877", "9,87,654.32"): additionally not part of a longer decimal number, which means
 *    no "." before it and no "." plus a digit after it. The development server writes timings into the HTML, and "5.556" is a
 *    piece of "12345.5567" that is nobody's quantity. A comma beside it is allowed (`a,9.877`), as is a full stop after it.
 */
function found(where: string, secret: string): boolean {
  if (!/^[\d.,]+$/.test(secret)) return where.includes(secret)
  const escaped = secret.replace(/[.]/g, "\\.")
  const pattern = /^\d+$/.test(secret) ? `(?<!\\d)${escaped}(?!\\d)` : `(?<![\\d.])${escaped}(?!\\d|\\.\\d)`
  return new RegExp(pattern).test(where)
}

/**
 * Which of `secrets` the page shows or carries. Read after the page has settled, so call it after an assertion on the page.
 * `typed` is what B itself put in the URL: a filter field echoes it back, which is B's own input, not a leak.
 */
async function leaksOn(page: Page, secrets: string[], typed: string[] = []): Promise<string[]> {
  const html = await page.content()
  const text = await page.locator("body").innerText()
  return secrets.filter((secret) => !typed.includes(secret) && (found(html, secret) || found(text, secret)))
}

test("the leak detector finds a figure wherever it is carried, and not inside a longer number", () => {
  // Carried as data: next to commas, quotes and brackets.
  expect(found("[98765432,12345678]", "98765432")).toBe(true)
  expect(found("[98765432,12345678]", "12345678")).toBe(true)
  expect(found("a,9.877", "9.877")).toBe(true)
  expect(found("1,2,765432", "765432")).toBe(true)
  expect(found('{"a":98765432}', "98765432")).toBe(true)
  // Shown as text, and at the end of a sentence.
  expect(found("x 5.556 g", "5.556")).toBe(true)
  expect(found("It held 9.877.", "9.877")).toBe(true)
  expect(found("9,87,654.32 in all", "9,87,654.32")).toBe(true)
  // A piece of a longer number is nobody's figure.
  expect(found("12.5.556", "5.556")).toBe(false)
  expect(found("5.5567", "5.556")).toBe(false)
  expect(found("123765432", "765432")).toBe(false)
  expect(found("7654321", "765432")).toBe(false)
  expect(found("19,87,654.32", "9,87,654.32")).toBe(false)
  // Names and ids are looked for as text.
  expect(found("a Zephyr b", "Zephyr")).toBe(true)
  expect(found("nothing here", "Zephyr")).toBe(false)
})

const netWorth = (page: Page) => page.getByRole("region", { name: "Net worth", exact: true })
const filters = (page: Page) => page.getByRole("form", { name: "Filter transactions" })

test("lists none of A's accounts in B's ledger, and A's money is not in B's net worth", async ({ pair: { a, b } }) => {
  await seedA(a.userId)
  await seedB(b.userId)
  const secrets = await secretsOfA(a.userId)

  // A's own screens show all of it, so a search that finds nothing on B's is not simply looking for the wrong thing.
  await a.page.goto("/nodes")
  await expect(netWorth(a.page).locator("p").first()).toHaveText(A_NET_WORTH)
  await expect(section(a.page, "Accounts")).toContainText(VAULT)
  expect((await leaksOn(a.page, secrets)).length).toBeGreaterThan(5)

  await b.page.goto("/nodes")
  await expect(netWorth(b.page).locator("p").first()).toHaveText("₹750.00")
  await expect(netWorth(b.page)).toContainText("₹750.00 in accounts, ₹0.00 invested, ₹0.00 owed.")
  await expect(section(b.page, "Accounts").getByRole("listitem")).toHaveCount(1)
  await expect(section(b.page, "Accounts").getByRole("listitem")).toContainText("Plain Wallet")
  await expect(section(b.page, "Liabilities").getByRole("listitem")).toHaveCount(0)
  expect(await leaksOn(b.page, secrets)).toEqual([])

  // The dashboard is a second route to the same figures.
  await b.page.goto("/")
  await expect(netWorth(b.page).locator("p").first()).toHaveText("₹750.00")
  await expect(section(b.page, "Accounts").getByRole("listitem")).toHaveCount(1)
  await expect(section(b.page, "Liabilities")).toHaveCount(0) // nothing owed, so no section at all
  expect(await leaksOn(b.page, secrets)).toEqual([])
})

test("shows none of A's transactions in B's list, however B filters it", async ({ pair: { a, b } }) => {
  await seedA(a.userId)
  await seedB(b.userId)
  const secrets = await secretsOfA(a.userId)
  const rows = (page: Page) => entries(page).getByRole("listitem")

  await a.page.goto("/transactions?from=&to=")
  await expect(rows(a.page).filter({ hasText: "Zephyr kayak, paid" })).toContainText("₹7,654.32")
  await expect(rows(a.page).filter({ hasText: "Zephyr signing bonus" })).toContainText("₹1,23,456.78")

  // The whole history: B's two entries (the wallet's opening balance and the bus pass), and nothing of A's.
  await b.page.goto("/transactions?from=&to=")
  await expect(rows(b.page)).toHaveCount(2)
  await expect(rows(b.page).filter({ hasText: "Bus pass" })).toContainText("Plain Wallet → Transport")
  await expect(rows(b.page).filter({ hasText: "Opening Balance → Plain Wallet" })).toHaveCount(1)
  await expect(balanceOf(b.page, "Plain Wallet")).toContainText("₹750.00")
  expect(await leaksOn(b.page, secrets)).toEqual([])

  // Searching for A's own words, or for A's own amounts, finds nothing: B's list is not narrowed from A's, it is B's.
  const searches: Record<string, string>[] = [
    { q: "Zephyr" },
    { q: "kayak" },
    { min: "7654.32", max: "7654.32" },
    { min: "100000" },
    { kind: "INCOME_SOURCE", q: "bonus" },
  ]
  for (const search of searches) {
    await b.page.goto(`/transactions?${new URLSearchParams({ from: "", to: "", ...search })}`)
    await expect(entries(b.page)).toContainText("Nothing recorded for these filters.")
    await expect(rows(b.page)).toHaveCount(0)
    expect(await leaksOn(b.page, secrets, ["Zephyr"]), JSON.stringify(search)).toEqual([])
  }
})

test("never offers A's accounts or ledgers in B's pickers", async ({ pair: { a, b } }) => {
  await seedA(a.userId)
  await seedB(b.userId)
  const aIds = (await prisma.ledgerNode.findMany({ where: { userId: a.userId } })).map((node) => node.id)
  const bNames = new Set((await prisma.ledgerNode.findMany({ where: { userId: b.userId } })).map((node) => node.name))

  /** Every option is one of B's own nodes: by label and by the id the form would send. */
  async function expectOnlyBs(select: ReturnType<Page["getByLabel"]>, where: string) {
    const labels = await optionsOf(select)
    expect(labels.length, `${where} offers something`).toBeGreaterThan(0)
    expect(labels.filter((label) => !bNames.has(label)), where).toEqual([])
    const values = await select.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
    expect(values.filter((value) => aIds.includes(value)), `${where} (ids)`).toEqual([])
  }

  // A's pickers do offer A's nodes, so the check below is a check of something.
  await a.page.goto("/transactions")
  expect(await optionsOf(form(a.page).getByLabel("From", { exact: true }))).toEqual(expect.arrayContaining([VAULT, EMPLOYER, HOBBY, PLATINUM]))

  await b.page.goto("/transactions")
  const from = form(b.page).getByLabel("From", { exact: true })
  const to = form(b.page).getByLabel("To", { exact: true })
  await expectOnlyBs(from, "source")
  await expectOnlyBs(filters(b.page).getByLabel("Involving"), "Involving filter")
  // The destination follows the source, for every kind of source B has.
  for (const source of ["Plain Wallet", "Transport", "Opening Balance"]) {
    await from.selectOption({ label: source })
    await expectOnlyBs(to, `destination after ${source}`)
  }
  // And so does each leg of a split.
  await from.selectOption({ label: "Plain Wallet" })
  await form(b.page).getByRole("button", { name: "Add split" }).click()
  for (const leg of ["Leg 1", "Leg 2"]) await expectOnlyBs(form(b.page).getByRole("group", { name: leg }).getByLabel("To"), leg)
  expect(await leaksOn(b.page, await secretsOfA(a.userId))).toEqual([])

  // A's pickers have not been touched by any of it: B recording something leaves A's choices as they were.
  await form(b.page).getByRole("button", { name: "Clear form" }).click()
  await record(b.page, "Plain Wallet", "Groceries", "10")
  await a.page.reload()
  expect(await optionsOf(form(a.page).getByLabel("From", { exact: true }))).toEqual(expect.arrayContaining([VAULT]))
  await expect(balanceOf(a.page, VAULT)).toContainText("₹11,03,456.78")
})

test("gives B nothing for a URL that carries A's identifiers, and no more than for one that names nothing", async ({ pair: { a, b } }) => {
  const kayak = await seedA(a.userId)
  await seedB(b.userId)
  const secrets = await secretsOfA(a.userId)
  const GHOST = "cm0000000000000000000ghost"
  const hits = (page: Page) => entries(page).getByRole("listitem")
  const screenFor = async (params: Record<string, string>) => {
    await b.page.goto(`/transactions?${new URLSearchParams({ from: "", to: "", ...params })}`)
    await expect(entries(b.page)).toContainText("Nothing recorded for these filters.")
    await expect(hits(b.page)).toHaveCount(0)
    expect(await leaksOn(b.page, secrets, Object.values(params)), JSON.stringify(params)).toEqual([])
    return b.page.locator("body").innerText()
  }

  // What B sees for an id that belongs to nobody. A's ids must look exactly like this, or the difference says "that one exists".
  const ghostNode = await screenFor({ node: GHOST })
  const ghostSearch = await screenFor({ q: GHOST })

  for (const node of [await nodeId(a.userId, VAULT), await nodeId(a.userId, HOBBY), await nodeId(a.userId, PLATINUM), kayak.id]) {
    expect(await screenFor({ node }), `node=${node}`).toBe(ghostNode)
  }
  expect(await screenFor({ q: kayak.id }), "q=<A's transaction>").toBe(ghostSearch)
  // Through the deleted filter too, which reaches rows the default list hides.
  // (Compared with a ghost id under the same switch: the filtered total says "Counts live entries only." whenever it is on.)
  expect(await screenFor({ node: await nodeId(a.userId, VAULT), deleted: "1" })).toBe(await screenFor({ node: GHOST, deleted: "1" }))

  // A, with the same URL, gets A's rows: it is the owner that makes the difference, not the URL.
  await a.page.goto(`/transactions?${new URLSearchParams({ from: "", to: "", node: await nodeId(a.userId, VAULT) })}`)
  await expect(hits(a.page).filter({ hasText: "Zephyr kayak, paid" })).toHaveCount(1)
})

test.describe("a request B's browser sends, aimed at A's rows", () => {
  const GHOST = "cm0000000000000000000ghost"
  const NOT_FOUND = "That transaction or account no longer exists."

  /** What a person sees and what came over the wire, for one attempt. */
  type Attempt = { message: string | null; status: number; body: string }

  /**
   * B does something ordinary on its own screen, but the request the page sends has B's id swapped for `target`. The
   * answer must be what B would get for an id that exists nowhere (the caller compares), and must not be a conflict, a
   * forbidden or anything else that says "that row is real".
   */
  async function aimed(b: Page, own: string, target: string, act: (page: Page) => Promise<void>, shown: (page: Page) => ReturnType<Page["getByRole"]>) {
    let swapped = 0
    const replies = await watchActions(b, (body) => {
      if (!body.includes(own)) return body
      swapped += 1
      return body.replaceAll(own, target)
    })
    await act(b)
    await expect(shown(b)).toBeVisible()
    expect(swapped, "the request that was sent did carry B's own id, so it was really aimed").toBe(1)
    const reply = replies[replies.length - 1]
    await b.unroute("**/*")
    return { message: await shown(b).textContent(), status: reply.status, body: reply.body } satisfies Attempt
  }

  test("an edit of A's transaction is refused as not found, and A's row is untouched", async ({ pair: { a, b } }) => {
    const kayak = await seedA(a.userId)
    const bus = await seedB(b.userId)
    const secrets = await secretsOfA(a.userId)
    const before = await prisma.transaction.findUniqueOrThrow({ where: { id: kayak.id } })
    // So B, who holds its own row's version, would meet a conflict if the owner were checked second.
    expect(before.version).toBeGreaterThan((await prisma.transaction.findUniqueOrThrow({ where: { id: bus.id } })).version)

    const edit = async (target: string) => {
      await b.page.goto("/transactions")
      return aimed(
        b.page,
        bus.id,
        target,
        async (page) => {
          const row = entries(page).getByRole("listitem").filter({ hasText: "Bus pass" })
          await row.getByRole("button", { expanded: false }).first().click()
          await row.getByRole("button", { name: "Edit" }).click()
          await editForm(page).getByLabel("Note").fill("Rewritten by B")
          await editForm(page).getByRole("button", { name: "Save changes" }).click()
        },
        (page) => editForm(page).getByRole("alert"),
      )
    }
    const toA = await edit(kayak.id)
    expect(toA.message).toContain(NOT_FOUND)
    expect(toA.message).not.toContain("changed somewhere else") // a version conflict would confirm that the row exists
    expect(await leaksOn(b.page, secrets)).toEqual([])
    const toNobody = await edit(GHOST)
    expect(toA).toEqual(toNobody)

    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: kayak.id } })).toEqual(before)
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: bus.id } })).note).toBe("Bus pass")
  })

  test("a delete of A's transaction is refused as not found, and the row stays live", async ({ pair: { a, b } }) => {
    const kayak = await seedA(a.userId)
    const bus = await seedB(b.userId)
    const secrets = await secretsOfA(a.userId)
    const before = await prisma.transaction.findUniqueOrThrow({ where: { id: kayak.id } })

    const remove = async (target: string) => {
      await b.page.goto("/transactions")
      const row = entries(b.page).getByRole("listitem").filter({ hasText: "Bus pass" })
      return aimed(
        b.page,
        bus.id,
        target,
        async () => {
          await row.getByRole("button", { expanded: false }).first().click()
          await row.getByRole("button", { name: "Delete", exact: true }).click()
        },
        () => row.getByRole("alert"),
      )
    }
    const toA = await remove(kayak.id)
    expect(toA.message).toContain(NOT_FOUND)
    expect(await leaksOn(b.page, secrets)).toEqual([])
    expect(toA).toEqual(await remove(GHOST))

    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: kayak.id } })).toEqual(before)
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: bus.id } })).deletedAt).toBeNull()
    await a.page.goto("/transactions")
    await expect(entries(a.page).getByRole("listitem").filter({ hasText: "Zephyr kayak, paid" })).toHaveCount(1)
  })

  test("recording a transaction into A's ledger is refused as not found, and nothing is written", async ({ pair: { a, b } }) => {
    await seedA(a.userId)
    await seedB(b.userId)
    const secrets = await secretsOfA(a.userId)
    const groceries = await nodeId(b.userId, "Groceries")
    const wallet = await nodeId(b.userId, "Plain Wallet")
    const counts = async () => ({
      a: await prisma.transaction.count({ where: { userId: a.userId } }),
      b: await prisma.transaction.count({ where: { userId: b.userId } }),
    })
    const before = await counts()

    // B spends from its wallet on Groceries, with `own` (B's wallet or B's Groceries) swapped for `target` on the way out.
    const spend = async (own: string, target: string) => {
      await b.page.goto("/transactions")
      return aimed(
        b.page,
        own,
        target,
        async (page) => {
          await form(page).getByLabel("From", { exact: true }).selectOption({ label: "Plain Wallet" })
          await form(page).getByLabel("To", { exact: true }).selectOption({ label: "Groceries" })
          await form(page).getByLabel("Amount (₹)").fill("10")
          await form(page).getByRole("button", { name: "Record transaction" }).click()
        },
        (page) => form(page).getByRole("alert"),
      )
    }
    // Into A's expense ledger, and out of A's account: the node on either end is looked up for B alone.
    const intoA = await spend(groceries, await nodeId(a.userId, HOBBY))
    expect(intoA.message).toContain(NOT_FOUND)
    expect(await leaksOn(b.page, secrets)).toEqual([])
    expect(intoA).toEqual(await spend(groceries, GHOST))
    const outOfA = await spend(wallet, await nodeId(a.userId, VAULT))
    expect(outOfA.message).toContain(NOT_FOUND)
    expect(await leaksOn(b.page, secrets)).toEqual([])
    expect(outOfA).toEqual(await spend(wallet, GHOST))
    expect(await counts()).toEqual(before)
    await a.page.goto("/transactions")
    await expect(balanceOf(a.page, VAULT)).toContainText("₹11,03,456.78")
  })
})

// Investments (M2). The same claim for the new surfaces: lots, a sale's consumptions and price history are one user's
// alone. A owns a gold holding bought in two lots with a part sold and three prices; B holds a little silver of its own
// (so B's screens are real ones that send real requests, and the request is then aimed at A's ids on the way out, as above).
// The browser reaches the investment actions only through the forms that call them, so that is how each is invoked.

const GOLD = "Zephyr Gold"
const GOLD_BANK = "Zephyr Gold Bank"
const SILVER = "Plain Silver"
const SILVER_WALLET = "Silver Wallet"

/**
 * A's amounts are ones nothing else on a page could be: 12.345 g for ₹73,456.78 and 4.321 g for ₹31,987.65, a sale of
 * 6.789 g for ₹52,345.67 (taken from the first lot, which leaves 5.556 g of it and 9.877 g in all), prices of ₹7,321.45
 * and ₹7,789.12 and, today, ₹8,012.34. Returns the day the last price is for.
 */
async function seedAInvestor(userId: string) {
  await account(userId, GOLD_BANK, "9,87,654.32")
  await investment(userId, GOLD, { unit: "g" })
  await buy(userId, GOLD_BANK, GOLD, "73,456.78", "12.345", "2026-01-10")
  await buy(userId, GOLD_BANK, GOLD, "31,987.65", "4.321", "2026-02-05")
  const day = await today(userId)
  await price(userId, GOLD, "7,321.45", "2026-03-01")
  await price(userId, GOLD, "7,789.12", "2026-04-01")
  await price(userId, GOLD, "8,012.34", day)
  await sellInvestment(userId, {
    nodeId: await nodeId(userId, GOLD),
    toNodeId: await nodeId(userId, GOLD_BANK),
    quantity: parseQuantity("6.789"),
    proceeds: parseRupees("52,345.67"),
    occurredAt: calendarDate("2026-04-15"),
    note: "Zephyr gold sold",
    idempotencyKey: randomUUID(),
  })
  return day
}

/** B: ₹10,000 in a wallet, 0.5 kg of silver for ₹4,000, priced today at ₹9,000 a kg. Net worth ₹10,500.00. */
async function seedBInvestor(userId: string) {
  await account(userId, SILVER_WALLET, "10,000")
  await investment(userId, SILVER, { unit: "kg" })
  await buy(userId, SILVER_WALLET, SILVER, "4,000", "0.5", "2026-03-15")
  await price(userId, SILVER, "9,000", await today(userId))
}
const B_NET_WORTH = "₹10,500.00"

/** Everything that identifies A's investment: names, ids, every quantity and amount as printed and as paise. */
async function secretsOfAInvestor(userId: string): Promise<string[]> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  const nodes = await prisma.ledgerNode.findMany({ where: { userId } })
  const transactions = await prisma.transaction.findMany({ where: { userId } })
  const lots = await prisma.investmentLot.findMany({ where: { userId } })
  const consumptions = await prisma.lotConsumption.findMany({ where: { userId } })
  const prices = await prisma.priceSnapshot.findMany({ where: { userId } })
  const paise = [
    ...transactions.map((t) => t.amountPaise),
    ...lots.map((lot) => lot.costBasisPaise),
    ...consumptions.map((c) => c.costBasisPaise),
    ...prices.map((p) => p.pricePerUnitPaise),
  ].map((amount) => amount.toString())
  const rupees = paise.map((amount) => formatPaiseText(amount).replace("₹", ""))
  const quantities = [...lots.map((lot) => lot.quantity.toString()), ...consumptions.map((c) => c.quantity.toString()), "5.556", "9.877"]
  return [
    "Zephyr",
    user.email,
    userId,
    ...nodes.map((node) => node.id),
    ...transactions.map((transaction) => transaction.id),
    ...lots.map((lot) => lot.id),
    ...paise,
    ...rupees,
    ...quantities,
  ]
}

/** All of A's investment rows, to compare before and after: lots, consumptions, prices and the transactions behind them. */
async function investmentRowsOf(userId: string) {
  return {
    lots: await prisma.investmentLot.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    consumptions: await prisma.lotConsumption.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    prices: await prisma.priceSnapshot.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    transactions: await prisma.transaction.findMany({ where: { userId }, orderBy: { id: "asc" } }),
  }
}

test("shows none of A's gold on B's investments, prices and dashboard, and leaves it out of B's net worth", async ({ pair: { a, b } }) => {
  await seedAInvestor(a.userId)
  await seedBInvestor(b.userId)
  const secrets = await secretsOfAInvestor(a.userId)
  const heading = (page: Page, name: string) => page.getByRole("heading", { level: 1, name })

  // A's own screens carry all of it, so a search that finds nothing on B's is not simply looking for the wrong thing.
  await a.page.goto("/investments")
  await expect(heading(a.page, "Investments")).toBeVisible()
  await expect(a.page.getByRole("region", { name: GOLD, exact: true })).toContainText("₹79,137.88")
  expect(await leaksOn(a.page, secrets)).toEqual(expect.arrayContaining(["Zephyr", await nodeId(a.userId, GOLD), "9.877", "8,012.34", "801234"]))
  await a.page.goto("/investments/prices")
  await expect(heading(a.page, "Record prices")).toBeVisible()
  await a.page.getByLabel("Investment").selectOption({ label: GOLD })
  await expect(a.page.getByRole("region", { name: `Prices of ${GOLD}` })).toContainText("₹7,789.12")
  await a.page.goto("/")
  const aNetWorth = (await netWorth(a.page).textContent()) ?? ""
  // The figures A's net worth is made of, so none of them may show up on B's screens either.
  const aFigures = [...aNetWorth.matchAll(/₹([\d,]+\.\d\d)/g)].map((match) => match[1]).filter((figure) => figure !== "0.00") // nothing owed is nobody's secret
  expect(aFigures.length).toBeGreaterThan(1)
  expect(aNetWorth).toContain("invested")
  secrets.push(...aFigures)

  await b.page.goto("/investments")
  await expect(heading(b.page, "Investments")).toBeVisible()
  await expect(b.page.getByRole("region", { name: SILVER, exact: true })).toContainText("₹4,500.00")
  await expect(b.page.getByRole("region", { name: "Portfolio", exact: true })).toContainText("₹4,500.00")
  await expect(b.page.getByRole("region", { name: GOLD, exact: true })).toHaveCount(0)
  expect(await leaksOn(b.page, secrets)).toEqual([])

  // The price screen offers only B's silver, by label and by the id the form would send, and reads only B's prices.
  await b.page.goto("/investments/prices")
  await expect(heading(b.page, "Record prices")).toBeVisible()
  const picker = b.page.getByLabel("Investment")
  expect(await optionsOf(picker)).toEqual([SILVER])
  const values = await picker.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
  const aIds = (await prisma.ledgerNode.findMany({ where: { userId: a.userId } })).map((node) => node.id)
  expect(values.filter((value) => aIds.includes(value))).toEqual([])
  await picker.selectOption({ label: SILVER })
  const history = b.page.getByRole("region", { name: `Prices of ${SILVER}` })
  await expect(history.getByRole("listitem")).toHaveCount(1)
  await expect(history).toContainText("₹9,000.00")
  expect(await leaksOn(b.page, secrets)).toEqual([])

  // B's net worth is B's own: the wallet and the silver, and nothing of the gold, on the dashboard and on the ledger.
  for (const path of ["/", "/nodes"]) {
    await b.page.goto(path)
    await expect(netWorth(b.page).locator("p").first()).toHaveText(B_NET_WORTH)
    await expect(netWorth(b.page)).toContainText("₹6,000.00 in accounts, ₹4,500.00 invested, ₹0.00 owed.")
    expect(await leaksOn(b.page, secrets), path).toEqual([])
  }
  await expect(section(b.page, "Accounts").getByRole("listitem")).toHaveCount(1)
})

test("lists none of A's gold in B's transactions, whatever B filters or names", async ({ pair: { a, b } }) => {
  await seedAInvestor(a.userId)
  await seedBInvestor(b.userId)
  const secrets = await secretsOfAInvestor(a.userId)
  const rows = (page: Page) => entries(page).getByRole("listitem")
  const goldId = await nodeId(a.userId, GOLD)
  const goldHistory = await prisma.transaction.findMany({ where: { userId: a.userId, OR: [{ toNodeId: goldId }, { fromNodeId: goldId }] } })
  expect(goldHistory.length).toBe(3) // two purchases, and the sale's cost-basis leg

  // A's list has the purchases, which is where the `quantity` a transaction view carries comes from.
  await a.page.goto("/transactions?from=&to=")
  await expect(rows(a.page).filter({ hasText: GOLD_BANK }).filter({ hasText: "₹73,456.78" })).toHaveCount(1)

  // B's whole history is its own two entries: the wallet's opening balance and the silver bought, and nothing else.
  await b.page.goto("/transactions?from=&to=")
  await expect(rows(b.page)).toHaveCount(2)
  await expect(rows(b.page).filter({ hasText: "Silver Wallet → Plain Silver" })).toContainText("₹4,000.00")
  expect(await leaksOn(b.page, secrets)).toEqual([])

  const GHOST = "cm0000000000000000000ghost"
  const screenFor = async (params: Record<string, string>) => {
    await b.page.goto(`/transactions?${new URLSearchParams({ from: "", to: "", ...params })}`)
    await expect(entries(b.page)).toContainText("Nothing recorded for these filters.")
    await expect(rows(b.page)).toHaveCount(0)
    expect(await leaksOn(b.page, secrets, Object.values(params)), JSON.stringify(params)).toEqual([])
    return b.page.locator("body").innerText()
  }
  // Searching for the gold, by name, by amount or by the id of the node or of a purchase, finds nothing; and A's ids answer
  // exactly as an id that exists nowhere does.
  await screenFor({ q: "Zephyr" })
  await screenFor({ q: "gold sold" })
  await screenFor({ min: "73456.78", max: "73456.78" })
  await screenFor({ kind: "INVESTMENT", q: "Zephyr" })
  const ghostNode = await screenFor({ node: GHOST })
  expect(await screenFor({ node: goldId }), "node=<A's gold>").toBe(ghostNode)
  expect(await screenFor({ node: goldId, deleted: "1" }), "node=<A's gold>, deleted").toBe(await screenFor({ node: GHOST, deleted: "1" }))
  const ghostSearch = await screenFor({ q: GHOST })
  for (const transaction of goldHistory) expect(await screenFor({ q: transaction.id }), `q=${transaction.id}`).toBe(ghostSearch)
})

test.describe("a request B's browser sends, aimed at A's gold", () => {
  const GHOST = "cm0000000000000000000ghost"
  const NOT_FOUND = "That investment, account or price was not found"

  /**
   * B does something ordinary on its own screen, but each request the page sends that `which` picks has B's id (`own`) swapped
   * for `target`. Everything the screen then showed and everything that came over the wire is returned; every answer must be
   * what an id that exists nowhere gets (the caller compares it with the ghost's), and must say "not found" and nothing more.
   * `settled` is how many answers to wait for.
   */
  async function aimed(page: Page, own: string, target: string, which: (body: string) => boolean, settled: number, act: () => Promise<void>) {
    let swapped = 0
    const replies = await watchActions(page, (body) => {
      if (!which(body) || !body.includes(own)) return body
      swapped += 1
      return body.replaceAll(own, target)
    })
    await act()
    await expect.poll(() => replies.length, "the answers that came back").toBe(settled)
    expect(swapped, "every request that was sent did carry B's own id, so it was really aimed").toBe(settled)
    await page.unroute("**/*")
    for (const reply of replies) {
      expect(reply.status).toBe(200)
      expect(reply.body).toContain('"code":"not_found"')
      expect(reply.body).not.toContain('"ok":true')
    }
    return replies.map((reply) => reply.body)
  }

  // The kinds of request, by what the body carries: a sale names a destination, a price day a price or a day, a holding only the id.
  const sale = (body: string) => body.includes('"toNodeId"')
  const priceOrPreview = (body: string) => body.includes('"price"')
  const priceDay = (body: string) => body.includes('"asOf"') && !body.includes('"price"')
  const holdingOnly = (body: string) => !body.includes('"asOf"') && !body.includes('"toNodeId"') && !body.includes('"price"')

  const sellForm = (page: Page) => page.getByRole("form", { name: `Sell ${SILVER}` })
  const priceForm = (page: Page) => page.getByRole("form", { name: "Record a price" })

  async function openSilverSale(page: Page) {
    await page.goto("/investments")
    await page.getByRole("region", { name: SILVER, exact: true }).getByRole("button", { name: "Sell / redeem" }).click()
    await sellForm(page).getByLabel(/^Quantity/).fill("0.1")
    await sellForm(page).getByLabel("Proceeds (₹)").fill("900")
    await sellForm(page).getByLabel("Paid into").selectOption({ label: SILVER_WALLET })
  }

  async function openSilverPrices(page: Page) {
    await page.goto("/investments/prices")
    await priceForm(page).getByLabel("Investment").selectOption({ label: SILVER })
    await expect(page.getByRole("region", { name: `Prices of ${SILVER}` }).getByRole("listitem")).toHaveCount(1)
  }

  test("the holding, a sale's preview and a price's preview of A's gold are answered as not found", async ({ pair: { a, b } }) => {
    await seedAInvestor(a.userId)
    await seedBInvestor(b.userId)
    const secrets = await secretsOfAInvestor(a.userId)
    const silver = await nodeId(b.userId, SILVER)
    const gold = await nodeId(a.userId, GOLD)
    const before = await investmentRowsOf(a.userId)

    // getHoldingAction: B opens its silver's holding and asks for its lots; the id goes out as A's.
    const holding = async (target: string) => {
      await b.page.goto("/investments")
      const silverCard = b.page.getByRole("region", { name: SILVER, exact: true })
      return aimed(b.page, silver, target, holdingOnly, 1, async () => {
        await silverCard.getByRole("button", { name: "Holding" }).click()
        await silverCard.getByRole("checkbox", { name: "Show lots" }).check()
        await expect(silverCard.getByRole("alert")).toContainText(NOT_FOUND)
      })
    }
    const holdingOfA = await holding(gold)
    expect(await leaksOn(b.page, secrets)).toEqual([])
    expect(holdingOfA).toEqual(await holding(GHOST))

    // previewSaleAction: the figures a sale would post, asked for as the form is filled in. Aimed at A's gold, with B's own
    // account as the destination, then with B's own silver and A's account as the destination.
    const previewSale = (own: string, target: string) =>
      aimed(b.page, own, target, sale, 1, async () => {
        await openSilverSale(b.page)
      })
    const saleOfA = await previewSale(silver, gold)
    expect(await leaksOn(b.page, secrets)).toEqual([])
    expect(saleOfA).toEqual(await previewSale(silver, GHOST))
    const wallet = await nodeId(b.userId, SILVER_WALLET)
    const intoA = await previewSale(wallet, await nodeId(a.userId, GOLD_BANK))
    expect(intoA).toEqual(await previewSale(wallet, GHOST))
    await expect(sellForm(b.page)).not.toContainText("Cost basis") // no figures were drawn from A's lots

    // previewPriceAction: what a price would make the investment worth, for a day on which A's gold has a price.
    const previewPrice = async (target: string) => {
      await openSilverPrices(b.page)
      return aimed(b.page, silver, target, priceOrPreview, 1, async () => {
        await priceForm(b.page).getByLabel("Date").fill(await today(a.userId))
        await priceForm(b.page).getByLabel(/^Price per/).fill("1,111")
        await expect(b.page.getByText("No value to show for these fields.")).toBeVisible()
      })
    }
    const priceOfA = await previewPrice(gold)
    expect(await leaksOn(b.page, secrets)).toEqual([])
    expect(priceOfA).toEqual(await previewPrice(GHOST))

    // Nothing was written, and A's rows are as they were.
    expect(await investmentRowsOf(a.userId)).toEqual(before)
  })

  test("a sale, a price and a price's deletion aimed at A's gold are refused as not found, and nothing of A's changes", async ({ pair: { a, b } }) => {
    const day = await seedAInvestor(a.userId)
    await seedBInvestor(b.userId)
    const secrets = await secretsOfAInvestor(a.userId)
    const silver = await nodeId(b.userId, SILVER)
    const wallet = await nodeId(b.userId, SILVER_WALLET)
    const gold = await nodeId(a.userId, GOLD)
    const before = await investmentRowsOf(a.userId)
    const countsOfB = async () => ({
      transactions: await prisma.transaction.count({ where: { userId: b.userId } }),
      lots: await prisma.investmentLot.count({ where: { userId: b.userId } }),
      consumptions: await prisma.lotConsumption.count({ where: { userId: b.userId } }),
      prices: await prisma.priceSnapshot.findMany({ where: { userId: b.userId } }),
    })
    const bBefore = await countsOfB()

    // sellAction: B sells 0.1 kg of its silver into its wallet; the request names A's gold (with B's wallet as the destination),
    // or names A's account as the destination. Two answers each: the form's preview, then the sale.
    const sell = async (own: string, target: string) => {
      let message = ""
      const bodies = await aimed(b.page, own, target, sale, 2, async () => {
        await openSilverSale(b.page)
        await expect.poll(() => b.page.getByRole("form", { name: `Sell ${SILVER}` }).count()).toBe(1)
        await sellForm(b.page).getByRole("button", { name: "Sell", exact: true }).click()
        await expect(sellForm(b.page).getByRole("alert")).toContainText(NOT_FOUND)
        message = (await sellForm(b.page).getByRole("alert").textContent()) ?? ""
      })
      return { bodies, message }
    }
    const sellOfA = await sell(silver, gold)
    expect(sellOfA.message).toContain(NOT_FOUND)
    expect(await leaksOn(b.page, secrets)).toEqual([])
    expect(sellOfA).toEqual(await sell(silver, GHOST))
    const sellIntoA = await sell(wallet, await nodeId(a.userId, GOLD_BANK))
    expect(sellIntoA.message).toContain(NOT_FOUND)
    expect(await leaksOn(b.page, secrets)).toEqual([])
    expect(sellIntoA).toEqual(await sell(wallet, GHOST))

    // recordPriceAction: B saves ₹1,111 for today, the day A's gold has its latest price (a leak would replace it).
    const savePrice = async (target: string) => {
      let message = ""
      await openSilverPrices(b.page)
      const bodies = await aimed(b.page, silver, target, priceOrPreview, 2, async () => {
        await priceForm(b.page).getByLabel("Date").fill(day)
        await priceForm(b.page).getByLabel(/^Price per/).fill("1,111")
        await expect.poll(() => b.page.getByText("No value to show for these fields.").count()).toBe(1)
        await priceForm(b.page).getByRole("button", { name: "Save price" }).click()
        await expect(priceForm(b.page).getByRole("alert")).toContainText(NOT_FOUND)
        message = (await priceForm(b.page).getByRole("alert").textContent()) ?? ""
      })
      return { bodies, message }
    }
    const savedToA = await savePrice(gold)
    expect(await leaksOn(b.page, secrets)).toEqual([])
    expect(savedToA).toEqual(await savePrice(GHOST))

    // deletePriceAction: B deletes the price it has for today; the request names A's gold, which has one for that day too.
    const remove = async (target: string) => {
      await openSilverPrices(b.page)
      const history = b.page.getByRole("region", { name: `Prices of ${SILVER}` })
      let message = ""
      const bodies = await aimed(b.page, silver, target, priceDay, 1, async () => {
        await history.getByRole("button", { name: /^Delete the price for/ }).click()
        await expect(history.getByRole("alert")).toContainText(NOT_FOUND)
        message = (await history.getByRole("alert").textContent()) ?? ""
      })
      return { bodies, message }
    }
    const deleteOfA = await remove(gold)
    expect(await leaksOn(b.page, secrets)).toEqual([])
    expect(deleteOfA).toEqual(await remove(GHOST))

    // A's lots, consumptions, prices and the transactions behind them are exactly as they were, B's silver and its price are
    // too, and the balance A sees has not moved (it holds the opening balance, the two purchases and the sale: ₹9,34,555.56).
    expect(await investmentRowsOf(a.userId)).toEqual(before)
    expect(await countsOfB()).toEqual(bBefore)
    await a.page.goto("/transactions")
    await expect(balanceOf(a.page, GOLD_BANK)).toContainText("₹9,34,555.56")
    await a.page.goto("/investments")
    await expect(a.page.getByRole("region", { name: GOLD, exact: true })).toContainText("₹79,137.88")
    await b.page.goto("/")
    await expect(netWorth(b.page).locator("p").first()).toHaveText(B_NET_WORTH)
  })
})

// Reports (M3). Every report is a sum over one user's entries, so a sum that forgot the owner would not show A's rows: it
// would show B a figure with A's money in it. So A's own reports are read first and every figure they print becomes a secret
// too, beside A's names, ids and amounts. The range is named in the URL and A's entries in it are dated in 2026, so the
// figures do not move with the day the suite runs: A is both the Zephyr ledger and the gold investor above (whose entries
// dated today fall after the range), with a February salary and a March spend added.

const REPORT_RANGE = "range=custom&from=2026-01-01&to=2026-04-30"
const REPORT_SLUGS = ["net-worth", "cash-flow", "spending", "income", "accounts", "investments"] as const

/**
 * A for the reports. In the range, in rupees: Zephyr Vault Savings takes 2,34,567.89 from Zephyr Employer on 10 Feb and pays
 * 3,456.78 to Zephyr Hobby on 12 Mar, closing April at 2,34,567.89 - 3,456.78 = 2,31,111.11. Zephyr Gold Bank pays 73,456.78
 * and 31,987.65 for the gold and takes 52,345.67 for the part sold: -73,456.78 - 31,987.65 + 52,345.67 = -53,098.76. In
 * accounts at the end of April, 2,31,111.11 - 53,098.76 = 1,78,012.35. The gold has no price before 1 Mar.
 */
async function seedAReports(userId: string) {
  await seedA(userId)
  await seedAInvestor(userId)
  await post(userId, EMPLOYER, VAULT, "2,34,567.89", { date: "2026-02-10", note: "Zephyr February pay" })
  await post(userId, VAULT, HOBBY, "3,456.78", { date: "2026-03-12", note: "Zephyr paddles" })
}

/** B for the reports: the silver investor, with ₹2,000 of pay on 1 Feb and a ₹250 bus pass on 3 Feb. */
async function seedBReports(userId: string) {
  await seedBInvestor(userId)
  await incomeSource(userId, "Plain Salary")
  await post(userId, "Plain Salary", SILVER_WALLET, "2,000", { date: "2026-02-01" })
  await post(userId, SILVER_WALLET, "Transport", "250", { date: "2026-02-03" })
}

/**
 * Open a report and wait for the real page (its range control), not the loading skeleton. The range shown ends where the
 * URL's does; where it starts depends on the report (the balance and cash flow reports begin with the user's history).
 */
async function openReport(page: Page, slug: string, extra = "") {
  await page.goto(`/reports/${slug}?${REPORT_RANGE}${extra}`)
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible()
  await expect(page.getByRole("form", { name: "Report range" })).toContainText(/Showing 1 (Jan|Feb) 2026 to 30 Apr 2026\./)
}

/** A drill link's name: the figure, then what it is of (read by a screen reader only, after a space the browser puts in). */
const drillName = (figure: string, context: string) => ({ name: new RegExp(`^${figure.replace(/[.]/g, "\\.")}\\s*${context}$`) })

/** What each report shows its owner, by hand: something of A's on A's screen, something of B's own on B's. */
const shows: Record<(typeof REPORT_SLUGS)[number], { a: (page: Page) => Promise<void>; b: (page: Page) => Promise<void> }> = {
  "net-worth": {
    a: (page) => expect(page.getByRole("region", { name: "Net worth on 30 Apr 2026" })).toContainText("₹1,78,012.35 in accounts"),
    b: (page) => expect(page.getByRole("region", { name: "Net worth on 30 Apr 2026" })).toBeVisible(),
  },
  "cash-flow": {
    a: async (page) => {
      await expect(page.getByRole("link", drillName("₹2,34,567.89", ", income, Feb 2026"))).toBeVisible()
      await expect(page.getByRole("link", drillName("₹3,456.78", ", spending, Mar 2026"))).toBeVisible()
    },
    b: async (page) => {
      await expect(page.getByRole("link", drillName("₹2,000.00", ", total income")).first()).toBeVisible()
      await expect(page.getByRole("link", drillName("₹250.00", ", total spending")).first()).toBeVisible()
    },
  },
  spending: {
    a: (page) => expect(page.getByRole("listitem").filter({ hasText: HOBBY })).toContainText("₹3,456.78"),
    b: (page) => expect(page.getByRole("listitem").filter({ hasText: "Transport" })).toContainText("₹250.00"),
  },
  income: {
    a: (page) => expect(page.getByRole("listitem").filter({ hasText: EMPLOYER })).toContainText("₹2,34,567.89"),
    b: (page) => expect(page.getByRole("listitem").filter({ hasText: "Plain Salary" })).toContainText("₹2,000.00"),
  },
  accounts: {
    a: (page) => expect(page.getByRole("img", { name: new RegExp(`^${VAULT}: balance at the end of each month\\..*closed at ₹2,31,111\\.11 on 30 Apr 2026\\.$`) })).toBeVisible(),
    b: (page) => expect(page.getByRole("img", { name: new RegExp(`^${SILVER_WALLET}: balance at the end of each month\\.`) })).toBeVisible(),
  },
  investments: {
    a: async (page) => {
      const months = page.getByRole("table", { name: /invested, value, gain and realised by month/ }).getByRole("rowgroup")
      await expect(months.filter({ hasText: "Jan 2026" }).getByRole("row").first()).toContainText("₹73,456.78")
      await expect(months.filter({ hasText: "Feb 2026" }).getByRole("row").first()).toContainText("₹1,05,444.43")
    },
    b: async (page) => {
      const months = page.getByRole("table", { name: /invested, value, gain and realised by month/ }).getByRole("rowgroup")
      await expect(months.filter({ hasText: "Mar 2026" }).getByRole("row").first()).toContainText("₹4,000.00")
    },
  },
}

test("shows B none of A's money on any report, and A's own reports all of it", async ({ pair: { a, b } }) => {
  await seedAReports(a.userId)
  await seedBReports(b.userId)
  const secrets = [...(await secretsOfA(a.userId)), ...(await secretsOfAInvestor(a.userId))]

  // A's reports show A's figures, and every figure they print is A's: none of them may reach B either.
  for (const slug of REPORT_SLUGS) {
    await openReport(a.page, slug)
    await shows[slug].a(a.page)
    // Not only the sidebar's email: A's amounts are on the page.
    expect((await leaksOn(a.page, secrets)).filter((secret) => /^[\d.,]+$/.test(secret)).length, slug).toBeGreaterThan(0)
    // As printed and as the paise a view would carry them in ("1,78,012.35" and "17801235"). Only the figures of ₹1,000 and
    // more: a short one ("1.25", "125") is nobody's in particular, and turns up in any page's styles and timings.
    const printed = [...(await a.page.getByRole("main").innerText()).matchAll(/₹([\d,]+\.\d\d)/g)].map((match) => match[1])
    for (const figure of printed.filter((figure) => figure.includes(","))) secrets.push(figure, figure.replace(/[,.]/g, ""))
  }
  expect(secrets).toEqual(expect.arrayContaining(["1,78,012.35", "2,31,111.11", "1,05,444.43"]))

  for (const slug of REPORT_SLUGS) {
    await openReport(b.page, slug)
    await shows[slug].b(b.page)
    expect(await leaksOn(b.page, secrets), slug).toEqual([])
  }
})

test("answers B's report of A's account or investment as not found, exactly as for an id that is nobody's", async ({ pair: { a, b } }) => {
  await seedAReports(a.userId)
  await seedBReports(b.userId)
  const secrets = [...new Set([...(await secretsOfA(a.userId)), ...(await secretsOfAInvestor(a.userId))])]
  const GHOST = "cm0000000000000000000ghost"

  /** What B gets for a report of `node`: the not-found page, with nothing of A's in it. */
  const reportFor = async (slug: string, node: string) => {
    await b.page.goto(`/reports/${slug}?${REPORT_RANGE}&node=${node}`)
    await expect(b.page.getByText("This page could not be found.")).toBeVisible()
    await expect(b.page.getByRole("form", { name: "Report range" })).toHaveCount(0)
    expect(await leaksOn(b.page, secrets, [node]), `${slug} node=${node}`).toEqual([])
    return b.page.locator("body").innerText()
  }
  const ghostAccount = await reportFor("accounts", GHOST)
  for (const name of [VAULT, GOLD_BANK, PLATINUM]) expect(await reportFor("accounts", await nodeId(a.userId, name)), name).toBe(ghostAccount)
  expect(await reportFor("investments", await nodeId(a.userId, GOLD)), GOLD).toBe(await reportFor("investments", GHOST))

  // A, with the same URL, gets A's account: it is the owner that makes the difference, not the URL.
  await openReport(a.page, "accounts", `&node=${await nodeId(a.userId, VAULT)}`)
  await shows.accounts.a(a.page)
  // And B's own account, by its id, is B's report.
  await openReport(b.page, "accounts", `&node=${await nodeId(b.userId, SILVER_WALLET)}`)
  await shows.accounts.b(b.page)
  expect(await leaksOn(b.page, secrets)).toEqual([])
})

// Recurring entries (M4). A rule and the entries it proposes are one user's, and every way in is by an id: a page names a rule
// in its URL, a button sends an entry's id to a Server Action. So B is shown none of A's rules or entries, and an id of A's
// in B's hands is answered as not found, exactly as an id that is nobody's, with A's rows as they were. A's rule is a daily one
// that started two days ago, so it has three entries waiting (A's nav badge says 3); B's has one.

const A_RULE = "Zephyr Subscription"
const A_NOTE = "Zephyr recurring note"
const B_RULE = "Plain Rule"

/** A's rule: ₹5,432.10 a day from Zephyr Vault Savings to Zephyr Hobby, three entries waiting. */
async function seedARecurring(userId: string) {
  await seedA(userId)
  const start = addDays(await today(userId), -2)
  return recurringRule(userId, { name: A_RULE, from: VAULT, to: HOBBY, rupees: "5,432.10", frequency: "DAILY", startDate: start, note: A_NOTE })
}

/** B's rule: ₹75 a day from Plain Wallet to Transport from today, one entry waiting. */
async function seedBRecurring(userId: string) {
  await seedB(userId)
  return recurringRule(userId, { name: B_RULE, from: "Plain Wallet", to: "Transport", rupees: "75", frequency: "DAILY", startDate: await today(userId) })
}

/** What identifies A's recurring rows: the rule and entry ids, and the amount as printed and as paise. */
async function recurringSecretsOfA(userId: string): Promise<string[]> {
  const rules = await prisma.recurringRule.findMany({ where: { userId } })
  const occurrences = await prisma.recurringOccurrence.findMany({ where: { userId } })
  return [...(await secretsOfA(userId)), ...rules.map((rule) => rule.id), ...occurrences.map((occurrence) => occurrence.id), "5,432.10", "543210", A_NOTE]
}

/** Every recurring row of a user as stored, in a fixed order, so "nothing changed" is a comparison of two reads. */
async function recurringRowsOf(userId: string) {
  return {
    rules: await prisma.recurringRule.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    occurrences: await prisma.recurringOccurrence.findMany({ where: { userId }, orderBy: { id: "asc" } }),
    transactions: await prisma.transaction.count({ where: { userId } }),
  }
}

const recurringNav = (page: Page) => page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Recurring/ }).first()
const waiting = (count: number) => new RegExp(`^Recurring\\s*,\\s*${count} waiting$`)
const inboxCards = (page: Page) => page.getByRole("region", { name: "Inbox", exact: true }).getByRole("listitem")

test("shows B none of A's rules or entries, and A's own screen all of them", async ({ pair: { a, b } }) => {
  await seedARecurring(a.userId)
  await seedBRecurring(b.userId)
  const secrets = await recurringSecretsOfA(a.userId)

  // A's own screen shows the rule and its three entries, so a search that finds nothing on B's is not looking for the wrong thing.
  await a.page.goto("/recurring")
  await expect(inboxCards(a.page)).toHaveCount(3)
  await expect(a.page.getByRole("region", { name: "Rules", exact: true })).toContainText(A_RULE)
  await expect(recurringNav(a.page)).toHaveAccessibleName(waiting(3))
  expect((await leaksOn(a.page, secrets)).filter((secret) => /^[\d.,]+$/.test(secret)).length).toBeGreaterThan(0)

  // B's screen has B's own one entry, its own badge, and nothing of A's, on the screen, in the HTML, on the other pages too.
  await b.page.goto("/recurring")
  await expect(inboxCards(b.page)).toHaveCount(1)
  await expect(b.page.getByRole("region", { name: "Rules", exact: true })).toContainText(B_RULE)
  await expect(b.page.getByRole("region", { name: "Rules", exact: true }).getByRole("listitem")).toHaveCount(1)
  await expect(recurringNav(b.page)).toHaveAccessibleName(waiting(1))
  expect(await leaksOn(b.page, secrets)).toEqual([])
  for (const path of ["/", "/transactions", "/recurring/new"]) {
    await b.page.goto(path)
    await expect(recurringNav(b.page)).toHaveAccessibleName(waiting(1))
    expect(await leaksOn(b.page, secrets), path).toEqual([])
  }
  // B's own net worth (₹1,000 less the ₹250 bus pass) has no pending entry in it either: not A's ₹5,432.10, nor B's own ₹75.
  await b.page.goto("/")
  await expect(netWorth(b.page).locator("p").first()).toHaveText("₹750.00")
})

test("answers B's visit to A's rule, or to a form made from A's transaction, as not found, exactly as for an id that is nobody's", async ({ pair: { a, b } }) => {
  const rule = await seedARecurring(a.userId)
  await seedBRecurring(b.userId)
  const secrets = await recurringSecretsOfA(a.userId)
  const GHOST = "cm0000000000000000000ghost"
  const aTransaction = await prisma.transaction.findFirstOrThrow({ where: { userId: a.userId, note: "Zephyr kayak, paid" } })

  /** What B gets at `path`: the not-found page, with nothing of A's in it (apart from the id B typed). */
  const visit = async (path: string, typed: string) => {
    await b.page.goto(path)
    await expect(b.page.getByText("This page could not be found.")).toBeVisible()
    await expect(b.page.getByRole("form")).toHaveCount(0)
    expect(await leaksOn(b.page, secrets, [typed]), path).toEqual([])
    return b.page.locator("body").innerText()
  }
  const ghostEdit = await visit(`/recurring/${GHOST}/edit`, GHOST)
  expect(await visit(`/recurring/${rule.id}/edit`, rule.id)).toBe(ghostEdit)
  const ghostNew = await visit(`/recurring/new?from=${GHOST}`, GHOST)
  expect(await visit(`/recurring/new?from=${aTransaction.id}`, aTransaction.id)).toBe(ghostNew)

  // A, at the same URLs, is let in: it is the owner that makes the difference.
  await a.page.goto(`/recurring/${rule.id}/edit`)
  await expect(a.page.getByRole("form", { name: "Edit rule" }).getByLabel("Name")).toHaveValue(A_RULE)
  await a.page.goto(`/recurring/new?from=${aTransaction.id}`)
  await expect(a.page.getByRole("form", { name: "New rule" }).getByLabel("Amount (₹)")).toHaveValue("7654.32")
})

test.describe("a request B's browser sends, aimed at A's rule and entries", () => {
  const GHOST = "cm0000000000000000000ghost"

  /**
   * B presses an ordinary button on its own screen, but the request the page sends has B's id swapped for `target`. The answer
   * must be a plain "not found" with nothing of A's in it, and the same for an id that exists nowhere (the caller compares).
   */
  async function aimed(page: Page, own: string, target: string, act: () => Promise<void>) {
    let swapped = 0
    const replies = await watchActions(page, (body) => {
      if (!body.includes(own)) return body
      swapped += 1
      return body.replaceAll(own, target)
    })
    await act()
    await expect.poll(() => replies.length, "the answer that came back").toBe(1)
    expect(swapped, "the request that was sent did carry B's own id, so it was really aimed").toBe(1)
    await page.unroute("**/*")
    const [reply] = replies
    expect(reply.status).toBe(200)
    expect(reply.body).toContain('"code":"not_found"')
    expect(reply.body).not.toContain('"ok":true')
    return reply.body
  }

  test("Post, Skip, Pause and Delete on A's ids are refused as not found, and change nothing", async ({ pair: { a, b } }) => {
    const aRule = await seedARecurring(a.userId)
    const bRule = await seedBRecurring(b.userId)
    const secrets = await recurringSecretsOfA(a.userId)
    const aOccurrence = await prisma.recurringOccurrence.findFirstOrThrow({ where: { userId: a.userId }, orderBy: { dueOn: "asc" } })
    const bOccurrence = await prisma.recurringOccurrence.findFirstOrThrow({ where: { userId: b.userId } })
    const aBefore = await recurringRowsOf(a.userId)
    const bBefore = await recurringRowsOf(b.userId)
    expect(aBefore.occurrences).toHaveLength(3)

    const ownCard = (page: Page) => inboxCards(page).filter({ hasText: B_RULE })
    const ownRule = (page: Page) => page.getByRole("region", { name: "Rules", exact: true }).getByRole("listitem").filter({ hasText: B_RULE })
    const attempts: Record<string, (target: string) => Promise<string>> = {
      post: async (target) => {
        await b.page.goto("/recurring")
        return aimed(b.page, bOccurrence.id, target, () => ownCard(b.page).getByRole("button", { name: "Post", exact: true }).click())
      },
      skip: async (target) => {
        await b.page.goto("/recurring")
        return aimed(b.page, bOccurrence.id, target, () => ownCard(b.page).getByRole("button", { name: "Skip", exact: true }).click())
      },
      pause: async (target) => {
        await b.page.goto("/recurring")
        return aimed(b.page, bRule.id, target, () => ownRule(b.page).getByRole("button", { name: /^Pause/ }).click())
      },
      delete: async (target) => {
        await b.page.goto("/recurring")
        return aimed(b.page, bRule.id, target, async () => {
          await ownRule(b.page).getByRole("button", { name: /^Delete/ }).click()
          await ownRule(b.page).getByRole("button", { name: "Delete rule" }).click()
        })
      },
    }
    const targets = { post: aOccurrence.id, skip: aOccurrence.id, pause: aRule.id, delete: aRule.id }

    for (const [name, attempt] of Object.entries(attempts)) {
      const toA = await attempt(targets[name as keyof typeof targets])
      expect(await leaksOn(b.page, secrets), `${name} aimed at A`).toEqual([])
      expect(toA, `${name}: A's id is answered as an id that is nobody's is`).toEqual(await attempt(GHOST))
      expect(await leaksOn(b.page, secrets), `${name} aimed at nothing`).toEqual([])
    }

    // A's rule, its three entries and its ledger are exactly as they were, and so is B's: its own entry still waits, its rule lives.
    expect(await recurringRowsOf(a.userId)).toEqual(aBefore)
    expect(await recurringRowsOf(b.userId)).toEqual(bBefore)
    await a.page.goto("/recurring")
    await expect(inboxCards(a.page)).toHaveCount(3)
    await expect(recurringNav(a.page)).toHaveAccessibleName(waiting(3))
    await a.page.goto("/")
    await expect(netWorth(a.page).locator("p").first()).toHaveText(A_NET_WORTH)
    await b.page.goto("/recurring")
    await expect(ownCard(b.page)).toHaveCount(1)
    await expect(ownRule(b.page)).toHaveCount(1)
  })
})
