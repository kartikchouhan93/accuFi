import type { Page } from "@playwright/test"
import { prisma } from "@/server/db"
import { editTransaction } from "@/server/services/transaction-service"
import { expect, section, test } from "./fixtures"
import { balanceOf, editForm, entries, form, optionsOf, record, watchActions } from "./screens"
import { account, addExpense, card, incomeSource, nodeId, post } from "./seed"

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
 * Which of `secrets` the page shows or carries. Read after the page has settled, so call it after an assertion on the page.
 * `typed` is what B itself put in the URL: a filter field echoes it back, which is B's own input, not a leak.
 */
async function leaksOn(page: Page, secrets: string[], typed: string[] = []): Promise<string[]> {
  const html = await page.content()
  const text = await page.locator("body").innerText()
  return secrets.filter((secret) => !typed.includes(secret) && (html.includes(secret) || text.includes(secret)))
}

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
  expect(await screenFor({ node: await nodeId(a.userId, VAULT), deleted: "1" })).toBe(ghostNode)

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
