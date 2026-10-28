import type { ReactElement, ReactNode } from "react"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { createRegistry } from "./repositories/fixtures"

// The pending count is read by the shell on every signed-in page and by the dashboard too. React's `cache()` makes those
// one read per request, but outside a server render it is a plain pass-through, so here it is replaced with the same
// per-key memo it gives inside one: the test then shows the helper is wrapped in it, and that the shell and the
// dashboard both go through the helper rather than reading the count themselves.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <Args extends unknown[], Result>(fn: (...args: Args) => Result) => {
    const memo = new Map<string, Result>()
    return (...args: Args) => {
      const key = JSON.stringify(args)
      if (!memo.has(key)) memo.set(key, fn(...args))
      return memo.get(key) as Result
    }
  },
}))
const { requireUserId, auth, UnauthenticatedError } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), auth: vi.fn(), UnauthenticatedError }
})
vi.mock("@/server/auth", () => ({ requireUserId, auth, UnauthenticatedError, signOut: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

const recurringRepo = await import("@/server/repositories/recurring-repository")
const { pendingCount } = await import("@/app/pending-count")
const { AppShell } = await import("@/app/app-shell")
const { default: DashboardPage } = await import("@/app/page")

const registry = createRegistry()
afterAll(registry.cleanup)
afterEach(() => vi.restoreAllMocks())

async function signedInUserWithPending(pending: number) {
  const user = await registry.makeUser()
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  const rule = await registry.makeRule(user.id, bank.id, food.id)
  for (let day = 1; day <= pending; day++) await registry.makeOccurrence(user.id, rule.id, `2026-05-${String(day).padStart(2, "0")}`)
  requireUserId.mockResolvedValue(user.id)
  auth.mockResolvedValue({ user: { id: user.id, email: user.email }, expires: "2099-01-01" })
  return user
}

describe("pendingCount", () => {
  it("reads the count once for however many times one request asks", async () => {
    const user = await signedInUserWithPending(2)
    const read = vi.spyOn(recurringRepo, "countPending")
    expect(await Promise.all([pendingCount(user.id), pendingCount(user.id), pendingCount(user.id)])).toEqual([2, 2, 2])
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("keeps users apart: another user's count is its own read", async () => {
    const first = await signedInUserWithPending(1)
    const second = await signedInUserWithPending(3)
    expect(await pendingCount(first.id)).toBe(1)
    expect(await pendingCount(second.id)).toBe(3)
  })

  it("is zero, and says so under [recurring], when the read fails", async () => {
    const user = await signedInUserWithPending(2)
    vi.spyOn(recurringRepo, "countPending").mockRejectedValue(new Error("connection reset"))
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await pendingCount(user.id)).toBe(0)
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0][0])).toMatch(/^\[recurring\] /)
  })
})

describe("the dashboard and the shell on one page", () => {
  it("read the count once between them", async () => {
    await signedInUserWithPending(2)
    const read = vi.spyOn(recurringRepo, "countPending")
    const page = (await DashboardPage()) as ReactElement<{ children: ReactNode }>
    expect(page).toBeDefined()
    await AppShell({ children: null, current: "dashboard" })
    expect(read).toHaveBeenCalledTimes(1)
  })
})
