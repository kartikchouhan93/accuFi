import { randomUUID } from "node:crypto"
import type { Page, Response } from "@playwright/test"
import { prisma } from "@/server/db"
import { clientIp } from "@/server/client-ip"
import { accountKey, ACCOUNT_MAX_ATTEMPTS, clearAttempts, consumeAttempt, ipKey, RATE_LIMIT, rateLimitKey } from "@/server/rate-limit"
import { createAccount } from "@/server/services/signup-service"
import { deleteUser, expect, row, test } from "./fixtures"
import { watchActions } from "./screens"

// Who is signed in is shown in the sidebar: an initial always, and the address once the rail opens. Opening it is part of
// what is checked, since a collapsed rail clips the address, and the address must be what is shown rather than merely
// present in the markup.
async function expectSignedInAs(page: Page, email: string) {
  const sidebar = page.getByRole("complementary")
  await sidebar.hover()
  const shown = sidebar.getByText(email, { exact: true })
  await expect(shown).toBeVisible()
  await expect(shown).toHaveCSS("opacity", "1")
}

// The authentication journey, driven through the real forms. Every other spec signs in through the signup service and
// the login form; this one is the only place the signup form, the failure paths, the lockout and sign-out are used.
//
// Rate limits are what make this file dangerous. Login is counted per (address, email) and per email; signup per address,
// and with no proxy declared (the default, and this suite's) every client shares the address "unknown". So every test
// here uses an email of its own (a lockout then strands nobody else), and a test that spends attempts clears the
// counters it used in a `finally`, straight through the rate-limit module, whether it passed or not.

const PASSWORD = "correct horse battery"
const TOO_MANY = "Too many attempts. Please wait a few minutes and try again."
const WRONG = "Incorrect email or password."

const freshEmail = () => `${randomUUID()}@e2e.test`

/** The address the application will key this suite's rate limits on: no proxy is declared, so every browser is the same. */
const ADDRESS = clientIp(new Headers())

const authForm = (page: Page) => page.locator("form")
const alert = (page: Page) => authForm(page).getByRole("alert")

/** Every counter a test could have spent for this email, plus the shared signup-address counter. */
async function forgetAttempts(email: string) {
  await Promise.all([
    clearAttempts(rateLimitKey("login", ADDRESS, email)),
    clearAttempts(accountKey(email)),
    clearAttempts(rateLimitKey("signup", ADDRESS, email)),
    // Shared by every signup in the instance: left alone, a few runs in a row would use up the 30 it allows per window.
    clearAttempts(ipKey("signup", ADDRESS)),
  ])
}

async function deleteUserByEmail(email: string) {
  const user = await prisma.user.findUnique({ where: { email } })
  if (user) await deleteUser(user.id)
  await forgetAttempts(email)
}

/** Run a test with a user created through the service (not the form), and remove it and its counters afterwards. */
async function withUser(body: (email: string) => Promise<void>) {
  const email = freshEmail()
  await createAccount({ email, password: PASSWORD })
  try {
    await body(email)
  } finally {
    await deleteUserByEmail(email)
  }
}

async function fillAuthForm(page: Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password").fill(password)
}

type Button = "Sign in" | "Create account"

/** Submit the open form and wait for the Server Action to answer. */
async function submit(page: Page, button: Button): Promise<void> {
  await Promise.all([
    page.waitForResponse((candidate: Response) => candidate.request().method() === "POST" && "next-action" in candidate.request().headers()),
    page.getByRole("button", { name: button }).click(),
  ])
}

/** Submit a form that is expected to refuse: resolves once the page has taken the answer and the form can be used again. */
async function submitRefused(page: Page, button: Button): Promise<void> {
  await submit(page, button)
  await expect(page.getByRole("button", { name: button })).toBeEnabled()
}

async function signInThroughForm(page: Page, email: string, password: string) {
  await page.goto("/login")
  await fillAuthForm(page, email, password)
  return submit(page, "Sign in")
}

/** The session cookie, whatever Auth.js calls it in this environment (the name carries a prefix in production). */
const sessionCookies = async (page: Page) => (await page.context().cookies()).filter((cookie) => /session-token/.test(cookie.name))

async function expectSignedOut(page: Page) {
  expect(await sessionCookies(page)).toHaveLength(0)
  for (const path of ["/", "/nodes", "/transactions"]) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/login$/)
  }
}

test("signs up through the form, lands signed in, and starts with the four system nodes", async ({ page }) => {
  const email = freshEmail()
  try {
    await page.goto("/signup")
    await fillAuthForm(page, email, PASSWORD)
    await submit(page, "Create account")

    // The dashboard of the account just made: signed in as that address, and a ledger with nothing of the user's own yet.
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible()
    await expectSignedInAs(page, email)
    await expect(page.getByRole("heading", { name: "Start with your first account" })).toBeVisible()
    expect(await sessionCookies(page)).toHaveLength(1)

    const user = await prisma.user.findUniqueOrThrow({ where: { email } })
    const system = await prisma.ledgerNode.findMany({ where: { userId: user.id, systemRole: { not: null } }, orderBy: { name: "asc" } })
    expect(system.map(({ name, kind, systemRole }) => ({ name, kind, systemRole }))).toEqual([
      { name: "Opening Balance", kind: "INCOME_SOURCE", systemRole: "OPENING_BALANCE" },
      { name: "Opening Balance Contra", kind: "EXPENSE", systemRole: "OPENING_BALANCE_CONTRA" },
      { name: "Realised Gain", kind: "INCOME_SOURCE", systemRole: "REALISED_GAIN" },
      { name: "Realised Loss", kind: "EXPENSE", systemRole: "REALISED_LOSS" },
    ])

    // And they are what the ledger screen shows, marked as the application's own.
    await page.goto("/nodes")
    for (const name of ["Opening Balance", "Opening Balance Contra", "Realised Gain", "Realised Loss"]) {
      await expect(row(page, name)).toContainText("System")
    }
  } finally {
    await deleteUserByEmail(email)
  }
})

test("refuses a duplicate email with a message the user can read, and leaves the first account alone", async ({ page }) => {
  await withUser(async (email) => {
    const before = await prisma.user.findUniqueOrThrow({ where: { email } })
    await page.goto("/signup")
    // The same address in a different case: it is the same account, so it must not be a second one.
    await fillAuthForm(page, email.replace(/^[^@]+/, (local) => local.toUpperCase()), "another long password")
    await submitRefused(page, "Create account")

    await expect(alert(page)).toHaveText("An account with this email already exists.")
    await expect(page).toHaveURL(/\/signup$/)
    expect(await sessionCookies(page)).toHaveLength(0)
    expect(await prisma.user.count({ where: { email: { equals: email, mode: "insensitive" } } })).toBe(1)
    // Not overwritten either: the stored hash is the one the first signup made.
    const after = await prisma.user.findUniqueOrThrow({ where: { email } })
    expect(after.passwordHash).toBe(before.passwordHash)
  })
})

test("refuses a password below the minimum, at the browser and at the server", async ({ page }) => {
  const email = freshEmail()
  try {
    await page.goto("/signup")
    await fillAuthForm(page, email, "short")

    // First the browser's own check: it stops the form before anything is sent.
    let sent = 0
    page.on("request", (request) => {
      if (request.method() === "POST" && "next-action" in request.headers()) sent += 1
    })
    await page.getByRole("button", { name: "Create account" }).click()
    expect(await page.getByLabel("Password").evaluate((input) => (input as HTMLInputElement).checkValidity())).toBe(false)
    expect(sent).toBe(0)
    await expect(page.getByLabel("Email")).toHaveValue(email)
    await expect(page.getByLabel("Password")).toHaveValue("short")

    // Then the server's rule, which a client that skips the browser's check meets: said in words, beside the form, and the
    // form still holds what the person typed so they can fix it rather than start again.
    await authForm(page).evaluate((element) => ((element as HTMLFormElement).noValidate = true))
    await submitRefused(page, "Create account")
    await expect(alert(page)).toHaveText("Password must be at least 8 characters")
    await expect(page).toHaveURL(/\/signup$/)
    expect(await prisma.user.count({ where: { email } })).toBe(0)
    expect(await sessionCookies(page)).toHaveLength(0)
  } finally {
    await forgetAttempts(email)
  }
})

// React 19 clears an uncontrolled form once its action settles, refused or not, so the fields are controlled (see
// AuthForm). A refusal must leave what the person typed, so one mistake costs one correction and not two fields retyped.
test("keeps the email and password after a refused signup", async ({ page }) => {
  const email = freshEmail()
  try {
    await page.goto("/signup")
    await fillAuthForm(page, email, "short")
    await authForm(page).evaluate((element) => ((element as HTMLFormElement).noValidate = true))
    await submitRefused(page, "Create account")
    await expect(alert(page)).toHaveText("Password must be at least 8 characters")
    await expect(page.getByLabel("Email")).toHaveValue(email)
    await expect(page.getByLabel("Password")).toHaveValue("short")
  } finally {
    await forgetAttempts(email)
  }
})

test("keeps what was typed after a signup refused for an email already in use", async ({ page }) => {
  await withUser(async (email) => {
    await page.goto("/signup")
    await fillAuthForm(page, email, "another long password")
    await submitRefused(page, "Create account")
    await expect(alert(page)).toHaveText("An account with this email already exists.")
    await expect(page.getByLabel("Email")).toHaveValue(email)
    await expect(page.getByLabel("Password")).toHaveValue("another long password")
  })
})

test("keeps the email and password after a refused login", async ({ page }) => {
  await withUser(async (email) => {
    await page.goto("/login")
    await fillAuthForm(page, email, "wrong horse battery")
    await submitRefused(page, "Sign in")
    await expect(alert(page)).toHaveText(WRONG)
    await expect(page.getByLabel("Email")).toHaveValue(email)
    await expect(page.getByLabel("Password")).toHaveValue("wrong horse battery")
  })
})

test("signs in through the form with the right credentials", async ({ page }) => {
  await withUser(async (email) => {
    await signInThroughForm(page, email, PASSWORD)

    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible()
    await expectSignedInAs(page, email)
    expect(await sessionCookies(page)).toHaveLength(1)
    // Signed in, the protected pages open and the sign-in page is no longer where you belong.
    await page.goto("/transactions")
    await expect(page.getByRole("heading", { level: 1, name: "Transactions" })).toBeVisible()
    await page.goto("/login")
    await expect(page).toHaveURL(/\/$/)
  })
})

test("refuses a wrong password and does not sign anyone in", async ({ page }) => {
  await withUser(async (email) => {
    await signInThroughForm(page, email, "not the password")

    await expect(alert(page)).toHaveText(WRONG)
    await expect(page).toHaveURL(/\/login$/)
    await expectSignedOut(page)
  })
})

test("answers an unknown email exactly as it answers a wrong password", async ({ page }) => {
  // The user-enumeration property: whatever a person can observe must be the same for "no such account" and "wrong
  // password", so asking the form tells them nothing about which addresses are registered. Both are observed the same way.
  const unknown = freshEmail()
  try {
    await withUser(async (known) => {
      const wire = await watchActions(page) // the form's own request, read as it passes through

      const observe = async (email: string, password: string) => {
        await page.context().clearCookies()
        wire.length = 0 // forget the earlier observation
        await signInThroughForm(page, email, password)
        await expect(alert(page)).toBeVisible()
        expect(wire).toHaveLength(1)
        return {
          // What came over the wire for the form's own request, and whether it tried to start a session...
          ...wire[0],
          // ...and where the browser is, and what it says there.
          url: new URL(page.url()).pathname,
          message: await alert(page).textContent(),
          cookies: await sessionCookies(page),
        }
      }

      const wrongPassword = await observe(known, "not the password")
      const noSuchAccount = await observe(unknown, "not the password")

      expect(wrongPassword.message).toBe(WRONG) // not an empty pair that happens to be equal
      expect(noSuchAccount).toEqual(wrongPassword)
      expect(noSuchAccount.status).toBe(200)
      expect(noSuchAccount.url).toBe("/login")
      expect(noSuchAccount.setCookie).toBeUndefined()
      expect(noSuchAccount.cookies).toEqual([])
      // And neither address is named in the answer, so it cannot be read back out of the page.
      expect(noSuchAccount.body).not.toContain(unknown)
      expect(wrongPassword.body).not.toContain(known)
    })
  } finally {
    await forgetAttempts(unknown)
  }
})

test("refuses further attempts after the limit, and says so, even to the right password", async ({ page }) => {
  await withUser(async (email) => {
    await page.goto("/login")
    // Ten attempts are allowed, and each is answered as an ordinary wrong password, the tenth included.
    for (let attempt = 1; attempt <= RATE_LIMIT.maxAttempts; attempt += 1) {
      await fillAuthForm(page, email, `wrong guess ${attempt}`)
      await submitRefused(page, "Sign in")
      await expect(alert(page), `attempt ${attempt}`).toHaveText(WRONG)
    }

    // The eleventh is refused before the password is looked at: it is the right one, and it does not get in.
    await fillAuthForm(page, email, PASSWORD)
    await submitRefused(page, "Sign in")
    await expect(alert(page)).toHaveText(TOO_MANY)
    await expect(page).toHaveURL(/\/login$/)
    await expectSignedOut(page)
    // The counter says the same: this address and email have spent more than they were given.
    const counter = await prisma.rateLimitCounter.findUniqueOrThrow({ where: { key: rateLimitKey("login", ADDRESS, email) } })
    expect(counter.count).toBeGreaterThan(RATE_LIMIT.maxAttempts)
  })
})

test("says the same thing about a locked-out address that has no account", async ({ page }) => {
  // Being locked out must not tell an attacker which addresses exist either: an unknown email that has used its attempts
  // is refused in the same words as a registered one.
  const unknown = freshEmail()
  try {
    for (let attempt = 0; attempt < RATE_LIMIT.maxAttempts; attempt += 1) {
      await consumeAttempt(rateLimitKey("login", ADDRESS, unknown))
    }
    await signInThroughForm(page, unknown, "any password")
    await expect(alert(page)).toHaveText(TOO_MANY)
    await expect(page).toHaveURL(/\/login$/)
  } finally {
    await forgetAttempts(unknown)
  }
})

test("limits one account across every address, whatever the per-address counter says", async ({ page }) => {
  // The per-address counter is the one that trips first in this setup, so the per-account ceiling is put there
  // directly: its budget used up, the address's own counter fresh. The right password is still refused.
  await withUser(async (email) => {
    for (let attempt = 0; attempt < ACCOUNT_MAX_ATTEMPTS; attempt += 1) await consumeAttempt(accountKey(email), ACCOUNT_MAX_ATTEMPTS)
    expect(await prisma.rateLimitCounter.count({ where: { key: rateLimitKey("login", ADDRESS, email) } })).toBe(0)

    await signInThroughForm(page, email, PASSWORD)
    await expect(alert(page)).toHaveText(TOO_MANY)
    await expect(page).toHaveURL(/\/login$/)
    await expectSignedOut(page)
  })
})

test("signs out, after which the protected pages are not reachable", async ({ ledger: page }) => {
  await expect(page.getByRole("heading", { level: 1, name: "Ledger" })).toBeVisible()
  expect(await sessionCookies(page)).toHaveLength(1)

  await page.getByRole("button", { name: "Sign out" }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to AccuFi" })).toBeVisible()
  await expectSignedOut(page)
  // Back does not return to a page of the signed-in app that still answers.
  await page.goBack()
  await page.reload()
  await expect(page).toHaveURL(/\/login$/)
})

for (const path of ["/", "/nodes", "/transactions"]) {
  test(`sends an unauthenticated visit to ${path} to /login`, async ({ page, request }) => {
    // What the server says, before a browser follows it...
    const response = await request.get(path, { maxRedirects: 0 })
    expect(response.status()).toBe(307)
    expect(response.headers().location).toMatch(/\/login$/)

    // ...and where a browser ends up, on a form that is ready to be used.
    await page.goto(path)
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole("heading", { level: 1, name: "Sign in to AccuFi" })).toBeVisible()
  })
}

test("keeps /api/health reachable without a session, because the container healthcheck has none", async ({ request }) => {
  const response = await request.get("/api/health", { maxRedirects: 0 })
  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ status: "ok", database: "up" })
})
