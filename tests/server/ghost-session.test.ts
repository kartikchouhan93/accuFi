import { randomUUID } from "node:crypto"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/server/db"
import { seedAccountNodes } from "@/server/services/account-seed"
import { createRegistry } from "./repositories/fixtures"

// A ghost session: a validly signed JWT for a user row that is gone (JWTs cannot be revoked, so one outlives its
// user by up to 24 hours). requireUserId() accepts it, so everything after it must treat "the authenticated user does
// not exist" as a dead session: redirect to /login, never crash and never fall back to a default.
const { requireUserId, auth, UnauthenticatedError } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), auth: vi.fn(), UnauthenticatedError }
})
vi.mock("@/server/auth", () => ({ requireUserId, auth, UnauthenticatedError, signOut: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
// The sign-in and sign-up actions pull in Auth.js itself; these tests only render the pages that host them.
vi.mock("@/app/(auth)/actions", () => ({ loginAction: vi.fn(), signupAction: vi.fn() }))

const nodeActions = await import("@/app/nodes/actions")
const { todayFor } = await import("@/server/services/clock")
const { NotFoundError, UserNotFoundError } = await import("@/server/repositories/errors")
const { default: DashboardPage } = await import("@/app/page")
const { default: NodesPage } = await import("@/app/nodes/page")
const { default: TransactionsPage } = await import("@/app/transactions/page")
const { default: LoginPage } = await import("@/app/(auth)/login/page")
const { default: SignupPage } = await import("@/app/(auth)/signup/page")

const registry = createRegistry()
afterAll(registry.cleanup)
beforeEach(() => {
  requireUserId.mockReset()
  auth.mockReset()
})

/** Where a call redirected to, or null if it returned; anything else it threw is rethrown. */
async function redirectTarget(run: () => unknown): Promise<string | null> {
  try {
    await run()
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2]
    throw error
  }
  return null
}

/** A session for an id that has no row, which is what a deleted user's cookie looks like. */
function ghost() {
  const userId = randomUUID()
  requireUserId.mockResolvedValue(userId)
  auth.mockResolvedValue({ user: { id: userId }, expires: "2099-01-01" })
  return userId
}

describe("a valid session whose user row is gone", () => {
  it("makes todayFor throw UserNotFoundError, which is not a NotFoundError", async () => {
    const error = await todayFor(randomUUID()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(UserNotFoundError)
    expect(error).not.toBeInstanceOf(NotFoundError)
  })

  it.each([
    ["the dashboard", () => DashboardPage()],
    ["the ledger", () => NodesPage()],
    ["the transaction screen", () => TransactionsPage({ searchParams: Promise.resolve({}) })],
  ])("redirects %s to /login instead of throwing", async (_name, page) => {
    ghost()
    expect(await redirectTarget(page)).toBe("/login")
  })

  it("redirects an action that dates an opening balance, and one that needs no date at all", async () => {
    ghost()
    const withBalance = { kind: "ASSET", name: "HDFC", assetSubtype: "SAVINGS", openingBalance: "100" }
    expect(await redirectTarget(() => nodeActions.createNodeAction(withBalance))).toBe("/login")
    const withoutBalance = { kind: "EXPENSE", name: "Food" }
    expect(await redirectTarget(() => nodeActions.createNodeAction(withoutBalance))).toBe("/login")
  })

  it("does not bounce the login and signup pages back to /, which would loop", async () => {
    ghost()
    expect(await redirectTarget(() => LoginPage())).toBeNull()
    expect(await redirectTarget(() => SignupPage())).toBeNull()
  })

  it("still sends a signed-in user who exists from the login page to /", async () => {
    const user = await registry.makeUser()
    auth.mockResolvedValue({ user: { id: user.id }, expires: "2099-01-01" })
    expect(await redirectTarget(() => LoginPage())).toBe("/")
    expect(await redirectTarget(() => SignupPage())).toBe("/")
  })
})

describe("an ordinary not-found", () => {
  it("is still not_found, not a redirect, for another user's node", async () => {
    const owner = await registry.makeUser()
    await prisma.$transaction((tx) => seedAccountNodes(tx, owner.id))
    const theirs = await prisma.ledgerNode.findFirstOrThrow({ where: { userId: owner.id, kind: "EXPENSE" } })
    const caller = await registry.makeUser()
    await prisma.$transaction((tx) => seedAccountNodes(tx, caller.id))
    requireUserId.mockResolvedValue(caller.id)
    const result = await nodeActions.renameNodeAction({ nodeId: theirs.id, name: "Mine now" })
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } })
  })

  it("is still not_found when the user exists and only the node is missing", async () => {
    const user = await registry.makeUser()
    await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
    requireUserId.mockResolvedValue(user.id)
    expect(await nodeActions.archiveNodeAction({ nodeId: randomUUID() })).toMatchObject({ ok: false, error: { code: "not_found" } })
  })
})
