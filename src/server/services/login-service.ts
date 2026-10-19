import { z } from "zod"
import { normaliseEmail } from "@/lib/email"
import { prisma } from "@/server/db"
import { hashPassword, verifyPassword } from "@/server/password"
import { clearAttempts, consumeAttempt, rateLimitKey } from "@/server/rate-limit"
import { PASSWORD_MAX_LENGTH } from "@/server/services/signup-service"

export class RateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many attempts. Try again later.")
    this.name = "RateLimitedError"
  }
}

const loginSchema = z.object({
  email: z.string().transform(normaliseEmail).pipe(z.string().min(1).max(254)),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
})

// Verified against when the email is unknown, so "no such user" costs the same time as "wrong password"
// and response time does not reveal which emails have accounts. Computed once, on first use.
let dummyHash: Promise<string> | undefined
const getDummyHash = () => (dummyHash ??= hashPassword("accufi-timing-equaliser"))

/**
 * Check an email and password. Returns the user, or null for any failure (unknown email, wrong password and
 * malformed input are indistinguishable). Throws RateLimitedError after too many attempts from this IP for this
 * email. This is the single choke point every sign-in path goes through, so the limit cannot be bypassed by
 * calling a different entry point. A success clears the counter.
 */
export async function authenticate(input: {
  email: string
  password: string
  ip: string
}): Promise<{ userId: string; email: string } | null> {
  const parsed = loginSchema.safeParse({ email: input.email, password: input.password })
  if (!parsed.success) return null
  const { email, password } = parsed.data

  const key = rateLimitKey("login", input.ip, email)
  const attempt = await consumeAttempt(key)
  if (!attempt.allowed) throw new RateLimitedError(attempt.retryAfterSeconds)

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, passwordHash: true } })
  const matches = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()))
  if (!user || !matches) return null

  await clearAttempts(key)
  return { userId: user.id, email: user.email }
}
