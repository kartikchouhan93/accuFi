import { describe, expect, it } from "vitest"
import { isPublicPath } from "@/server/auth.config"
import { clientIp } from "@/server/client-ip"

describe("isPublicPath", () => {
  it.each(["/login", "/signup", "/api/health", "/login/", "/api/auth/csrf", "/api/auth/callback/credentials", "/api/auth/session"])(
    "lets %s through without a session",
    (path) => expect(isPublicPath(path)).toBe(true),
  )

  it.each(["/", "/transactions", "/api/healthz", "/api/health/details", "/loginx", "/login-admin", "/signup/extra", "/api/authx", "/api/other", "/api"])(
    "requires a session for %s",
    (path) => expect(isPublicPath(path)).toBe(false),
  )
})

describe("clientIp", () => {
  it("uses the last X-Forwarded-For entry, which the nearest proxy appended, not the forgeable first", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9")
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9")
  })

  it("falls back to X-Real-IP and then to a fixed placeholder", () => {
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4")
    expect(clientIp(new Headers())).toBe("unknown")
  })
})
