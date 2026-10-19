import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const delegatedPost = vi.fn(async () => new Response("delegated", { status: 200 }))
const delegatedGet = vi.fn(async () => new Response("get", { status: 200 }))
vi.mock("@/server/auth", () => ({ handlers: { GET: delegatedGet, POST: delegatedPost } }))

const limited = vi.fn()
vi.mock("@/server/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/rate-limit")>()),
  isLimited: limited,
}))

const { POST, GET } = await import("@/app/api/auth/[...nextauth]/route")

function credentialsPost(email: string, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3000/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ email, password: "pw", csrfToken: "t" }),
  })
}

beforeEach(() => {
  delegatedPost.mockClear()
  limited.mockReset()
})

describe("/api/auth route", () => {
  it("answers 429 with Retry-After once the IP and email are limited, without reaching Auth.js", async () => {
    limited.mockResolvedValue(true)
    const res = await POST(credentialsPost("a@b.com", { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))
    expect(res.status).toBe(429)
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(delegatedPost).not.toHaveBeenCalled()
  })

  it("hands the request to Auth.js while under the limit", async () => {
    limited.mockResolvedValue(false)
    const res = await POST(credentialsPost("a@b.com"))
    expect(res.status).toBe(200)
    expect(delegatedPost).toHaveBeenCalledOnce()
  })

  it("hands other POSTs (sign-out, CSRF) straight to Auth.js without a limit check", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/signout", { method: "POST" })
    await POST(req)
    expect(limited).not.toHaveBeenCalled()
    expect(delegatedPost).toHaveBeenCalledOnce()
  })

  it("still lets Auth.js handle a credentials POST it cannot parse, rather than failing open or crashing", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(delegatedPost).toHaveBeenCalledOnce()
  })

  it("exposes GET from Auth.js", async () => {
    expect((await GET(new NextRequest("http://localhost:3000/api/auth/session"))).status).toBe(200)
  })
})
