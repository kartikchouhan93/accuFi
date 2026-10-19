import { afterEach, describe, expect, it, vi } from "vitest"
import { assertProductionAuthUrl, isPublicPath } from "@/server/auth.config"
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
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("ignores X-Forwarded-For and X-Real-IP entirely unless a proxy is declared", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "")
    const forged = new Headers({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" })
    expect(clientIp(forged)).toBe("unknown")
    expect(clientIp(new Headers())).toBe("unknown")
  })

  it("treats 0, junk and negative hop counts as no proxy", () => {
    for (const hops of ["0", "abc", "-1", "1.5", " "]) {
      vi.stubEnv("TRUSTED_PROXY_HOPS", hops)
      expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6" })), `hops=${hops}`).toBe("unknown")
    }
  })

  it("with one trusted proxy, uses the last entry, which that proxy appended, not the forgeable first", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1")
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9")
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9")
  })

  it("with two trusted proxies, uses the second entry from the right", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2")
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9")
  })

  it("returns unknown when the header is absent or shorter than the declared proxy chain", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2")
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("unknown")
    expect(clientIp(new Headers())).toBe("unknown")
  })
})

describe("assertProductionAuthUrl", () => {
  it("refuses to start in production without AUTH_URL, since trustHost would fall back to the Host header", () => {
    expect(() => assertProductionAuthUrl({ NODE_ENV: "production" })).toThrow(/AUTH_URL/)
    expect(() => assertProductionAuthUrl({ NODE_ENV: "production", AUTH_URL: "" })).toThrow(/AUTH_URL/)
  })

  it("allows production with AUTH_URL, development and test without it, and the production build phase", () => {
    expect(() => assertProductionAuthUrl({ NODE_ENV: "production", AUTH_URL: "https://accufi.example" })).not.toThrow()
    expect(() => assertProductionAuthUrl({ NODE_ENV: "development" })).not.toThrow()
    expect(() => assertProductionAuthUrl({ NODE_ENV: "test" })).not.toThrow()
    // `next build` imports server modules with NODE_ENV=production before any runtime env exists
    expect(() => assertProductionAuthUrl({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })).not.toThrow()
  })
})
