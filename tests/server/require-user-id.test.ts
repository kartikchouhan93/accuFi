import { beforeEach, describe, expect, it, vi } from "vitest"

// Replace Auth.js itself: requireUserId's job is to turn "whatever the verified session says" into a user id
// or a refusal, and to never accept an id from its caller.
const sessionFromCookie = vi.fn()
vi.mock("next-auth", () => ({
  CredentialsSignin: class extends Error {},
  default: () => ({
    auth: sessionFromCookie,
    handlers: { GET: vi.fn(), POST: vi.fn() },
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}))
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }))

const { requireUserId, UnauthenticatedError } = await import("@/server/auth")

beforeEach(() => {
  sessionFromCookie.mockReset()
})

describe("requireUserId", () => {
  it("returns the id from the verified session", async () => {
    sessionFromCookie.mockResolvedValue({ user: { id: "user-1" }, expires: "2099-01-01" })
    expect(await requireUserId()).toBe("user-1")
  })

  it("throws UnauthenticatedError when there is no session", async () => {
    sessionFromCookie.mockResolvedValue(null)
    await expect(requireUserId()).rejects.toThrow(UnauthenticatedError)
  })

  it("throws when the session carries no user id", async () => {
    sessionFromCookie.mockResolvedValue({ user: {}, expires: "2099-01-01" })
    await expect(requireUserId()).rejects.toThrow(UnauthenticatedError)
    sessionFromCookie.mockResolvedValue({ user: { id: "" }, expires: "2099-01-01" })
    await expect(requireUserId()).rejects.toThrow(UnauthenticatedError)
    sessionFromCookie.mockResolvedValue({ expires: "2099-01-01" })
    await expect(requireUserId()).rejects.toThrow(UnauthenticatedError)
  })

  it("re-checks the session on every call", async () => {
    sessionFromCookie.mockResolvedValueOnce({ user: { id: "user-1" }, expires: "2099-01-01" })
    sessionFromCookie.mockResolvedValueOnce(null)
    expect(await requireUserId()).toBe("user-1")
    await expect(requireUserId()).rejects.toThrow(UnauthenticatedError)
    expect(sessionFromCookie).toHaveBeenCalledTimes(2)
  })

  it("accepts no caller-supplied id: it takes no parameters", () => {
    expect(requireUserId.length).toBe(0)
  })
})
