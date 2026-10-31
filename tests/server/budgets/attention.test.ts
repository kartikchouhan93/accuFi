import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { createRegistry } from "../repositories/fixtures"

// As tests/server/pending-count.test.ts: outside a server render `cache()` is a pass-through, so it is replaced by the
// per-key memo it gives inside one, which shows the helper is wrapped in it.
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

const budgetReport = await import("@/server/services/budget-report")
const { budgetAttention } = await import("@/app/budget-attention")
const { BudgetNotice } = await import("@/app/budget-notice")
const { default: DashboardPage } = await import("@/app/page")

const registry = createRegistry()
afterAll(registry.cleanup)
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("BudgetNotice", () => {
  it("says one budget needs attention, linking to /budgets", () => {
    const html = renderToStaticMarkup(createElement(BudgetNotice, { count: 1 }))
    expect(html).toContain("1 budget needs attention")
    expect(html).toContain('href="/budgets"')
  })

  it("says how many when there are several", () => {
    expect(renderToStaticMarkup(createElement(BudgetNotice, { count: 3 }))).toContain("3 budgets need attention")
  })

  it("draws nothing for none", () => {
    expect(renderToStaticMarkup(createElement(BudgetNotice, { count: 0 }))).toBe("")
  })
})

describe("budgetAttention", () => {
  it("is near plus over, read once for however many times one request asks", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-05-19T06:00:00Z") })
    const user = await registry.makeUser()
    const bank = await registry.makeNode(user.id, "ASSET", "Bank")
    const near = await registry.makeNode(user.id, "EXPENSE", "Near")
    const over = await registry.makeNode(user.id, "EXPENSE", "Over")
    const fine = await registry.makeNode(user.id, "EXPENSE", "Fine")
    for (const [node, spent] of [[near, 90_000n], [over, 120_000n], [fine, 10_000n]] as const) {
      await registry.makeBudget(user.id, node.id, { amountPaise: 100_000n })
      await registry.makeTransaction(user.id, bank.id, node.id, { amountPaise: spent, occurredAt: calendarDate("2026-05-05") })
    }
    const read = vi.spyOn(budgetReport, "loadBudgetAttention")
    expect(await Promise.all([budgetAttention(user.id), budgetAttention(user.id)])).toEqual([2, 2])
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("is zero, and says so under [budgets], when the read fails", async () => {
    const user = await registry.makeUser()
    vi.spyOn(budgetReport, "loadBudgetAttention").mockRejectedValue(new Error("connection reset"))
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await budgetAttention(user.id)).toBe(0)
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0][0])).toMatch(/^\[budgets\] /)
  })
})

/** Every element of a rendered tree (server components are left unexpanded) whose type is `type`. */
function find(node: ReactNode, type: unknown): ReactElement[] {
  if (!isValidElement(node)) return []
  const element = node as ReactElement<{ children?: ReactNode }>
  const here = element.type === type ? [element] : []
  return [...here, ...Children.toArray(element.props.children).flatMap((child) => find(child, type))]
}

describe("the dashboard", () => {
  it("shows the budget notice beside the pending one when a budget needs attention, and none otherwise", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-05-19T06:00:00Z") })
    const user = await registry.makeUser()
    requireUserId.mockResolvedValue(user.id)
    const food = await registry.makeNode(user.id, "EXPENSE", "Food")
    await registry.makeBudget(user.id, food.id, { amountPaise: 100_000n })
    expect(find(await DashboardPage(), BudgetNotice)).toHaveLength(0)

    // The count is memoised per user for a request (the `cache()` stand-in above), so the second page is a second user.
    const second = await registry.makeUser()
    requireUserId.mockResolvedValue(second.id)
    const secondBank = await registry.makeNode(second.id, "ASSET", "Bank")
    const secondFood = await registry.makeNode(second.id, "EXPENSE", "Food")
    await registry.makeBudget(second.id, secondFood.id, { amountPaise: 100_000n })
    await registry.makeTransaction(second.id, secondBank.id, secondFood.id, { amountPaise: 90_000n, occurredAt: "2026-05-05" })
    const [notice] = find(await DashboardPage(), BudgetNotice)
    expect(notice.props).toEqual({ count: 1 })
  })
})
