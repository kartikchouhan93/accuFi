import { beforeEach, describe, expect, it, vi } from "vitest"

// The Auth.js sign-in event hook. NextAuth is replaced by a function that keeps the options it is given, so the hook
// can be called as Auth.js would call it, without a browser. The real sign-in is covered end to end in the e2e suite.
const captured = vi.hoisted(() => ({ options: undefined as undefined | { events?: { signIn?: (message: { user: { id?: string } }) => void } } }))
vi.mock("next-auth", () => ({
  default: (options: typeof captured.options) => {
    captured.options = options
    return { auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }
  },
  CredentialsSignin: class {},
}))
vi.mock("next-auth/providers/credentials", () => ({ default: () => ({}) }))
vi.mock("@/server/services/login-service", () => ({ authenticate: vi.fn(), RateLimitedError: class {} }))

const generateInBackground = vi.fn()
vi.mock("@/server/services/recurring-generation", () => ({ generateInBackground }))

await import("@/server/auth")

beforeEach(() => generateInBackground.mockClear())

describe("the Auth.js signIn event", () => {
  it("starts background generation for the user who signed in", () => {
    captured.options?.events?.signIn?.({ user: { id: "user-1" } })
    expect(generateInBackground).toHaveBeenCalledExactlyOnceWith("user-1")
  })

  it("does nothing when the event carries no user id", () => {
    captured.options?.events?.signIn?.({ user: {} })
    expect(generateInBackground).not.toHaveBeenCalled()
  })
})
