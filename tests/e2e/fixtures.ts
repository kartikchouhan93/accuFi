import { randomUUID } from "node:crypto"
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test"
import { prisma } from "@/server/db"
import { createAccount } from "@/server/services/signup-service"

// Each test gets its own account, created straight through the signup service (a fresh user with the system nodes and
// starter expense ledgers) and signed in through the real login form. Going through the service rather than the
// signup page keeps the suite clear of the signup rate limit, which is per address and shared by every client when no
// proxy is declared. The user and everything it owns is deleted afterwards.

const PASSWORD = "correct horse battery"

/** Deletes a user and everything it owns. Exported for tests that create their own users (through the signup form). */
export async function deleteUser(userId: string) {
  // The investment tables first: their foreign keys to transactions and nodes are RESTRICT.
  await prisma.lotConsumption.deleteMany({ where: { userId } })
  await prisma.investmentLot.deleteMany({ where: { userId } })
  await prisma.priceSnapshot.deleteMany({ where: { userId } })
  await prisma.transaction.deleteMany({ where: { userId } })
  await prisma.transactionGroup.deleteMany({ where: { userId } })
  await prisma.ledgerNode.deleteMany({ where: { userId, parentId: { not: null } } })
  await prisma.ledgerNode.deleteMany({ where: { userId } })
  await prisma.user.deleteMany({ where: { id: userId } })
}

// Creates the account, signs the page in through the real login form, and returns the user's id for tests that seed data
// straight through the services. The caller deletes the user afterwards.
async function signIn(page: Page): Promise<string> {
  const email = `${randomUUID()}@e2e.test`
  const { userId } = await createAccount({ email, password: PASSWORD })
  try {
    await page.goto("/login")
    await page.getByLabel("Email").fill(email)
    await page.getByLabel("Password").fill(PASSWORD)
    await page.getByRole("button", { name: "Sign in" }).click()
    await page.waitForURL((url) => url.pathname !== "/login")
  } catch (error) {
    await deleteUser(userId)
    throw error
  }
  return userId
}

type Session = { page: Page; userId: string }

export const test = base.extend<{ ledger: Page; session: Session; pair: { a: Session; b: Session } }>({
  // Named `provide`, not `use`: React's hooks lint treats a call to `use` as a hook.
  ledger: async ({ page }, provide) => {
    const userId = await signIn(page)
    try {
      await page.goto("/nodes")
      await provide(page)
    } finally {
      await deleteUser(userId)
    }
  },
  // The same signed-in page, with the user's id so a test can put the ledger into a known state before it looks at it.
  session: async ({ page }, provide) => {
    const userId = await signIn(page)
    try {
      await provide({ page, userId })
    } finally {
      await deleteUser(userId)
    }
  },
  // Two independent users, each in a browser context of its own, so their cookies cannot reach each other. A signs in
  // first. A context made with browser.newContext() does not inherit the project's baseURL, so it is passed explicitly.
  pair: async ({ browser, baseURL }, provide) => {
    const users: string[] = []
    const contexts: BrowserContext[] = []
    try {
      const open = async (): Promise<Session> => {
        const context = await browser.newContext({ baseURL })
        contexts.push(context)
        const page = await context.newPage()
        const userId = await signIn(page)
        users.push(userId)
        return { page, userId }
      }
      const a = await open()
      const b = await open()
      await provide({ a, b })
    } finally {
      await Promise.all(contexts.map((context) => context.close()))
      for (const userId of users) await deleteUser(userId)
    }
  },
})

export { expect }

/** One section of the ledger, by its heading ("Accounts", "Investments", ...). */
export function section(page: Page, name: string) {
  return page.getByRole("region", { name, exact: true })
}

/** The ledger row for a node, found by its name. */
export function row(page: Page, name: string) {
  // By the name as a whole: "Opening Balance" must not also find "Opening Balance Contra".
  return page.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) })
}

/** Expand a row (its details and actions) if it is not already open. */
export async function openRow(page: Page, name: string) {
  const target = row(page, name)
  await expect(target).toBeVisible() // a row just added only appears once the server has been asked again
  const toggle = target.getByRole("button", { expanded: false }).first()
  if (await toggle.count()) await toggle.click()
  await expect(target.getByRole("button", { expanded: true })).toBeVisible()
  return target
}

/**
 * Choose a kind in the form, then fill its fields. Fields are keyed by their visible label, so a field that the kind
 * does not have fails the test rather than being skipped.
 */
export async function addNode(page: Page, kind: string, fields: Record<string, string>) {
  await page.getByRole("radio", { name: kind, exact: true }).check()
  for (const [label, value] of Object.entries(fields)) {
    const control = page.getByLabel(label, { exact: true })
    if ((await control.evaluate((el) => el.tagName)) === "SELECT") await control.selectOption({ label: value })
    else await control.fill(value)
  }
}
