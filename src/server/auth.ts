import NextAuth, { CredentialsSignin } from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { authConfig } from "@/server/auth.config"
import { authLogger } from "@/server/auth-logger"
import { clientIp } from "@/server/client-ip"
import { authenticate, RateLimitedError } from "@/server/services/login-service"
import { generateInBackground } from "@/server/services/recurring-generation"

/** Surfaced to the sign-in form as `code === "rate_limited"`. */
export class RateLimitedSignin extends CredentialsSignin {
  code = "rate_limited"
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Not signed in")
    this.name = "UnauthenticatedError"
  }
}

// No database adapter: with the JWT strategy and the Credentials provider Auth.js never calls one (users are
// created by createAccount, sessions live in the cookie), and the adapter's own tables would sit empty.
export const { auth, handlers, signIn, signOut } = NextAuth({
  ...authConfig,
  // Only `error` is overridden (a wrong password is not one); `warn` and `debug` keep Auth.js's defaults.
  logger: authLogger,
  // Catch up the user's recurring entries the moment they arrive, so an instance that was switched off is current by the
  // time the inbox is opened. Fire and forget: it returns at once and swallows its own errors, so it cannot fail a sign-in.
  events: {
    signIn: ({ user }) => {
      if (user.id) generateInBackground(user.id)
    },
  },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(credentials, request) {
        const { email, password } = credentials ?? {}
        if (typeof email !== "string" || typeof password !== "string") return null
        try {
          const user = await authenticate({ email, password, ip: clientIp(request.headers) })
          return user && { id: user.userId, email: user.email }
        } catch (error) {
          if (error instanceof RateLimitedError) throw new RateLimitedSignin()
          throw error
        }
      },
    }),
  ],
})

/**
 * The signed-in user's id, taken from the verified session on every call. Every Server Action calls this first and
 * passes the result into a repository that scopes its queries: it is the one place a user id enters the system, so
 * it accepts no argument, and a caller can never hand it an id to be trusted. Throws UnauthenticatedError.
 */
export async function requireUserId(): Promise<string> {
  const session = await auth()
  const userId = session?.user?.id
  if (typeof userId !== "string" || userId.length === 0) throw new UnauthenticatedError()
  return userId
}
