import type { Page } from "@playwright/test"
import { expect } from "./fixtures"

// The parts of the transaction screen that more than one spec drives, and the one way a spec watches or rewrites what a
// page sends to a Server Action. The older specs keep their own copies of the locators; nothing here changes what they do.

export const form = (page: Page) => page.getByRole("form", { name: "Record a transaction" })
export const editForm = (page: Page) => page.getByRole("form", { name: "Edit transaction" })
export const entries = (page: Page) => page.getByRole("region", { name: "Entries" })
export const balances = (page: Page) => page.getByRole("region", { name: "Balances" })

/** The line of the Balances list for a node. */
export const balanceOf = (page: Page, name: string) => balances(page).getByRole("listitem").filter({ hasText: name })

/** The visible option labels of a select, without its placeholder. */
export async function optionsOf(select: ReturnType<Page["getByLabel"]>): Promise<string[]> {
  const labels = await select.locator("option").allTextContents()
  return labels.filter((label) => label !== "" && !label.startsWith("Choose") && !label.startsWith("Any"))
}

/**
 * Fill the transaction form and submit it; resolves once the form has cleared, which it only does for a recorded entry.
 * Amounts are typed as the user types them ("85,000").
 */
export async function record(page: Page, from: string, to: string, rupees: string, over: { note?: string; date?: string } = {}) {
  await form(page).getByLabel("From", { exact: true }).selectOption({ label: from })
  await form(page).getByLabel("To", { exact: true }).selectOption({ label: to })
  await form(page).getByLabel("Amount (₹)").fill(rupees)
  if (over.date !== undefined) await form(page).getByLabel("Date").fill(over.date)
  if (over.note !== undefined) await form(page).getByLabel("Note").fill(over.note)
  await form(page).getByRole("button", { name: "Record transaction" }).click()
  await expect(form(page).getByLabel("Amount (₹)")).toHaveValue("")
}

/** One Server Action response, as the browser received it. */
export type ActionReply = { status: number; setCookie: string | undefined; body: string }

/**
 * Records every Server Action response the page receives, in order, and optionally rewrites what the page sends first
 * (`rewrite` gets the request body and returns the one to send; returning it unchanged leaves the request alone). A
 * response body is gone once the browser has moved on, so it is read as it passes through. The body is normalised: the
 * timestamp and render timing Next puts in every response differ by design and are dropped.
 */
export async function watchActions(page: Page, rewrite: (body: string) => string = (body) => body): Promise<ActionReply[]> {
  const replies: ActionReply[] = []
  await page.route("**/*", async (route) => {
    const request = route.request()
    if (request.method() !== "POST" || !("next-action" in request.headers())) return route.fallback()
    const response = await route.fetch({ postData: rewrite(request.postData() ?? "") })
    const raw = await response.text()
    const body = raw.replace(/:N[\d.]+/, "").replace(/1:D\{[^}]*\}/, "").replace(/\s+/g, " ").trim()
    replies.push({ status: response.status(), setCookie: response.headers()["set-cookie"], body })
    return route.fulfill({ response, body: raw })
  })
  return replies
}
