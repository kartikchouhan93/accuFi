import { randomUUID } from "node:crypto"
import { test as base, expect, type Page } from "@playwright/test"
import { prisma } from "@/server/db"
import { createAccount } from "@/server/services/signup-service"

// Each test gets its own account, created straight through the signup service (a fresh user with the system nodes and
// starter expense ledgers) and signed in through the real login form. Going through the service rather than the
// signup page keeps the suite clear of the signup rate limit, which is per address and shared by every client when no
// proxy is declared. The user and everything it owns is deleted afterwards.

const PASSWORD = "correct horse battery"

async function deleteUser(userId: string) {
  await prisma.transaction.deleteMany({ where: { userId } })
  await prisma.ledgerNode.deleteMany({ where: { userId, parentId: { not: null } } })
  await prisma.ledgerNode.deleteMany({ where: { userId } })
  await prisma.user.deleteMany({ where: { id: userId } })
}

export const test = base.extend<{ ledger: Page }>({
  // Named `provide`, not `use`: React's hooks lint treats a call to `use` as a hook.
  ledger: async ({ page }, provide) => {
    const email = `${randomUUID()}@e2e.test`
    const { userId } = await createAccount({ email, password: PASSWORD })
    try {
      await page.goto("/login")
      await page.getByLabel("Email").fill(email)
      await page.getByLabel("Password").fill(PASSWORD)
      await page.getByRole("button", { name: "Sign in" }).click()
      await page.waitForURL((url) => url.pathname !== "/login")
      await page.goto("/nodes")
      await provide(page)
    } finally {
      await deleteUser(userId)
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
