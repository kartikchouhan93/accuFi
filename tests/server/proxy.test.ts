import { describe, expect, it, vi } from "vitest"

// Auth.js's `auth(handler)` wraps a handler and supplies `req.auth` from the session cookie. Replace it with the
// identity so the test drives the guard's own decision directly with `auth` null or set.
vi.mock("next-auth", () => ({ default: () => ({ auth: (handler: unknown) => handler }) }))

const { default: guard, config } = await import("@/proxy")
const handler = guard as unknown as (req: { nextUrl: URL; auth: unknown }) => Response

const request = (path: string, auth: unknown) => ({ nextUrl: new URL(`http://localhost:3000${path}`), auth })

describe("route guard handler", () => {
  it("redirects an unauthenticated request for a protected page to /login", () => {
    for (const path of ["/", "/transactions", "/api/anything", "/api/healthz"]) {
      const res = handler(request(path, null))
      expect(res.status, path).toBe(307)
      expect(new URL(res.headers.get("location") as string).pathname, path).toBe("/login")
    }
  })

  it("lets the public paths through without a session", () => {
    for (const path of ["/login", "/signup", "/api/health", "/api/auth/csrf"]) {
      const res = handler(request(path, null))
      expect(res.headers.get("location"), path).toBeNull()
      expect(res.status, path).toBe(200)
    }
  })

  it("lets a signed-in request through", () => {
    const res = handler(request("/transactions", { user: { id: "u1" } }))
    expect(res.headers.get("location")).toBeNull()
    expect(res.status).toBe(200)
  })
})

describe("route guard matcher", () => {
  // Pinned: narrowing this silently unguards every route it stops matching.
  it("is exactly the catch-all minus Next's static assets and the favicon", () => {
    expect(config.matcher).toEqual(["/((?!_next/static|_next/image|favicon.ico).*)"])
  })

  it("covers pages and API routes, and excludes only static assets", () => {
    const re = new RegExp(`^${config.matcher[0]}$`)
    for (const path of ["/", "/transactions", "/login", "/api/health", "/api/auth/session", "/api/anything/deep"]) {
      expect(re.test(path), path).toBe(true)
    }
    for (const path of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico"]) {
      expect(re.test(path), path).toBe(false)
    }
  })
})
