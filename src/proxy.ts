import NextAuth from "next-auth"
import { NextResponse } from "next/server"
import { authConfig, isPublicPath } from "@/server/auth.config"

// The route guard: anything but the public paths needs a valid session cookie, otherwise it is sent to /login.
// It is the first line of defence only. Every Server Action still calls requireUserId(), because a guard on the
// URL says nothing about who is calling an action. Built from the edge-safe config, so it never loads Prisma/argon2.
const { auth } = NextAuth(authConfig)

export default auth((req) => {
  if (isPublicPath(req.nextUrl.pathname) || req.auth) return NextResponse.next()
  return NextResponse.redirect(new URL("/login", req.nextUrl))
})

export const config = {
  // Everything except Next's static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
