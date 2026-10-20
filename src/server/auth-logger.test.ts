import { CallbackRouteError, CredentialsSignin } from "@auth/core/errors"
import { afterEach, describe, expect, it, vi } from "vitest"
import { authLogger } from "@/server/auth-logger"

afterEach(() => vi.restoreAllMocks())

// The subclass auth.ts throws for a locked-out client; it must be as quiet as a wrong password.
class RateLimitedSignin extends CredentialsSignin {
  code = "rate_limited"
}

// Auth.js builds this itself, from whatever `authorize` threw; its constructor is marked internal and typed for strings only.
const callbackRouteError = (thrown: Error) =>
  new (CallbackRouteError as unknown as new (thrown: Error, details?: object) => CallbackRouteError)(thrown, { provider: "credentials" })

const printed = (log: { mock: { calls: unknown[][] } }) =>
  log.mock.calls.flat().map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(" ")

describe("authLogger.error", () => {
  // A wrong password, an unknown email and a lockout are routine answers, not faults: one stack trace per typo buries the real ones.
  it.each([
    ["a wrong password or unknown email", () => new CredentialsSignin()],
    ["a rate-limited attempt", () => new RateLimitedSignin()],
  ])("logs nothing for %s", (_name, make) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    authLogger.error(make())
    expect(log).not.toHaveBeenCalled()
  })

  // Anything thrown inside authorize other than a rejection (a database outage, a broken argon2 binding) reaches Auth.js
  // wrapped in a CallbackRouteError, and the operator has to see it.
  it("still logs a real failure inside authorize, with its cause", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:5432")
    authLogger.error(callbackRouteError(cause))
    expect(log).toHaveBeenCalled()
    expect(printed(log)).toContain("CallbackRouteError")
    expect(printed(log)).toContain("ECONNREFUSED")
  })

  it("still logs a plain Error and an AuthError that is not a credentials rejection", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    authLogger.error(new Error("boom"))
    expect(printed(log)).toContain("boom")
    log.mockClear()
    authLogger.error(callbackRouteError(new Error("x")))
    expect(log).toHaveBeenCalled()
  })
})
