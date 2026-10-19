import { NextResponse, type NextRequest } from "next/server"
import { handlers } from "@/server/auth"
import { clientIp } from "@/server/client-ip"
import { isLimited, rateLimitKey } from "@/server/rate-limit"

export const { GET } = handlers

async function submittedEmail(req: NextRequest): Promise<string | null> {
  try {
    const email = (await req.clone().formData()).get("email")
    return typeof email === "string" ? email : null
  } catch {
    return null
  }
}

// Auth.js answers a failed sign-in with a redirect. This answers a real 429 once the limit is hit. It is only the
// HTTP-visible half: the count itself happens in authenticate() (src/server/services/login-service.ts), which every
// sign-in path goes through, including the sign-in Server Actions that never reach this route. So if the body
// cannot be read here, letting the request through fails safe: authenticate() still refuses it.
export async function POST(req: NextRequest) {
  if (req.nextUrl.pathname === "/api/auth/callback/credentials") {
    const email = await submittedEmail(req)
    if (email !== null && (await isLimited(rateLimitKey("login", clientIp(req.headers), email)))) {
      return NextResponse.json(
        { error: "too_many_attempts" },
        { status: 429, headers: { "Retry-After": "900" } },
      )
    }
  }
  return handlers.POST(req)
}
