import type { DefaultSession, NextAuthConfig } from "next-auth"

// The part of the Auth.js configuration that is safe to load anywhere, including the edge runtime the route guard
// may run in: no Prisma, no argon2, no Node-only imports. src/server/auth.ts adds the providers that need them.

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"]
  }
}

// Sessions are JWTs, not database rows: Auth.js requires the JWT strategy whenever the Credentials provider is
// used. The trade-off is that a session cannot be revoked server-side before it expires, so the lifetime is short.
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60

export const authConfig = {
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  // The session cookie is httpOnly and sameSite=lax (Auth.js defaults, which this config does not loosen) and is
  // marked Secure, with the __Secure- name prefix, in production.
  useSecureCookies: process.env.NODE_ENV === "production",
  // A self-hosted instance cannot know the public host name in advance; without this Auth.js refuses every
  // request in production. Nothing here builds an absolute URL from the Host header: redirects are relative.
  trustHost: true,
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.sub = user.id
      return token
    },
    session({ session, token }) {
      // The id comes from the verified, signed JWT and from nowhere else.
      if (token.sub) session.user.id = token.sub
      return session
    },
  },
} satisfies NextAuthConfig

// Reachable without a session. Exact matches only (plus Auth.js's own endpoints, which must be reachable to sign
// in at all and enforce their own CSRF and rate checks): "/api/healthz" or "/loginx" must not slip through.
const PUBLIC_PATHS = new Set(["/login", "/signup", "/api/health"])

export function isPublicPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
  return PUBLIC_PATHS.has(path) || path === "/api/auth" || path.startsWith("/api/auth/")
}
