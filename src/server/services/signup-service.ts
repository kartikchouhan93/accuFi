import { Prisma } from "@prisma/client"
import { z } from "zod"
import { normaliseEmail } from "@/lib/email"
import { assertValidTimezone, DEFAULT_TIMEZONE } from "@/domain/timezone"
import { prisma } from "@/server/db"
import { hashPassword } from "@/server/password"
import { seedAccountNodes } from "@/server/services/account-seed"

export class EmailTakenError extends Error {
  constructor() {
    super("An account with this email already exists")
    this.name = "EmailTakenError"
  }
}

export class InvalidSignupInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidSignupInputError"
  }
}

export const PASSWORD_MIN_LENGTH = 8
// An upper bound so a hostile client cannot make the server hash megabytes; far above any real password.
export const PASSWORD_MAX_LENGTH = 128

const signupSchema = z.object({
  email: z.string().transform(normaliseEmail).pipe(z.email("Enter a valid email address").max(254)),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`),
})

function isEmailUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false
  const target = error.meta?.target
  return Array.isArray(target) ? target.includes("email") : String(target).includes("email")
}

/**
 * Create a user and everything they need to start: system nodes and starter ledgers. The user row and every node
 * are written in one transaction, so a failure part-way leaves nothing behind.
 */
export async function createAccount(input: {
  email: string
  password: string
  timezone?: string
}): Promise<{ userId: string }> {
  const parsed = signupSchema.safeParse({ email: input.email, password: input.password })
  if (!parsed.success) throw new InvalidSignupInputError(parsed.error.issues[0].message)
  // User.timezone is a user setting that todayIn() hands to Intl; reject a bad zone before it is ever stored.
  const timezone = assertValidTimezone(input.timezone ?? DEFAULT_TIMEZONE)

  // Hash before opening the transaction: argon2 is deliberately slow and must not hold a connection.
  const passwordHash = await hashPassword(parsed.data.password)

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: parsed.data.email, passwordHash, timezone },
        select: { id: true },
      })
      await seedAccountNodes(tx, user.id)
      return { userId: user.id }
    })
  } catch (error) {
    // No "does this email exist?" pre-check: it would race. The unique index is the arbiter.
    if (isEmailUniqueViolation(error)) throw new EmailTakenError()
    throw error
  }
}
