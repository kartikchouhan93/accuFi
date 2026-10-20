import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures"

// The theme is light, dark, or whatever the system prefers. These drive the real toggle and read what the browser
// actually paints, so a token that stopped applying would fail here and not only in a stylesheet nobody opens.

const toggle = (page: Page) => page.getByRole("button", { name: /^Theme:/ })

// The page's background as red, green, blue. Dark is far darker than light, so which one is showing is not in doubt.
async function backdrop(page: Page): Promise<number[]> {
  const rgb = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  return (rgb.match(/\d+/g) ?? []).slice(0, 3).map(Number)
}

const chosen = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme ?? null)
const stored = (page: Page) => page.evaluate(() => localStorage.getItem("accufi-theme"))

test("follows the system until a choice is made", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto("/login")
  expect(await chosen(page)).toBeNull()
  expect((await backdrop(page))[0]).toBeLessThan(40)

  await page.emulateMedia({ colorScheme: "light" })
  expect(await chosen(page)).toBeNull()
  expect((await backdrop(page))[0]).toBeGreaterThan(200)
})

test("says what it is and what it will do next", async ({ page }) => {
  await page.goto("/login")
  await expect(toggle(page)).toHaveAccessibleName("Theme: System. Switch to Light")
  await toggle(page).click()
  await expect(toggle(page)).toHaveAccessibleName("Theme: Light. Switch to Dark")
  await toggle(page).click()
  await expect(toggle(page)).toHaveAccessibleName("Theme: Dark. Switch to System")
})

test("lets a visitor pick dark over a light system, and keeps it across a reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto("/login")
  expect((await backdrop(page))[0]).toBeGreaterThan(200)

  await toggle(page).click() // light
  await toggle(page).click() // dark
  expect(await chosen(page)).toBe("dark")
  expect(await stored(page)).toBe("dark")
  expect((await backdrop(page))[0]).toBeLessThan(40) // the system still says light; the choice wins

  await page.reload()
  expect(await chosen(page)).toBe("dark")
  expect((await backdrop(page))[0]).toBeLessThan(40)
  await expect(toggle(page)).toHaveAccessibleName("Theme: Dark. Switch to System")
})

test("pick light over a dark system, the other way round", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto("/login")
  expect((await backdrop(page))[0]).toBeLessThan(40)

  await toggle(page).click() // light
  expect(await chosen(page)).toBe("light")
  expect((await backdrop(page))[0]).toBeGreaterThan(200)
})

test("returns to following the system on the third press, and says so in storage", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto("/login")
  await toggle(page).click()
  await toggle(page).click()
  await toggle(page).click()
  expect(await chosen(page)).toBeNull()
  expect(await stored(page)).toBe("system")
  expect((await backdrop(page))[0]).toBeLessThan(40) // following the dark system again
})

test("ignores a value in storage it does not recognise", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.addInitScript(() => localStorage.setItem("accufi-theme", "neon"))
  await page.goto("/login")
  expect(await chosen(page)).toBeNull()
  await expect(toggle(page)).toHaveAccessibleName("Theme: System. Switch to Light")
})

test("carries the choice from page to page once signed in", async ({ session: { page } }) => {
  await page.emulateMedia({ colorScheme: "light" })
  await page.goto("/nodes")
  // Wait for the real page, not the loading skeleton that stands in for it: the skeleton has the sidebar too, but is
  // replaced a moment later, and a click on it may land before the page has hydrated.
  await expect(page.getByRole("heading", { level: 1, name: "Ledger" })).toBeVisible()
  const sidebar = page.getByRole("complementary")
  await sidebar.getByRole("button", { name: /^Theme:/ }).click() // light
  await sidebar.getByRole("button", { name: /^Theme:/ }).click() // dark
  expect(await chosen(page)).toBe("dark")

  for (const [path, heading] of [["/transactions", "Transactions"], ["/", "Dashboard"]] as const) {
    await page.goto(path)
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible()
    expect(await chosen(page)).toBe("dark")
    expect((await backdrop(page))[0]).toBeLessThan(40)
  }
})
