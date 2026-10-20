"use server"

import { AuthError } from "next-auth"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { InvalidTimezoneError } from "@/domain/timezone"
import { signIn } from "@/server/auth"
import { clientIp } from "@/server/client-ip"
import { consumeSignupAttempt } from "@/server/rate-limit"
import { createAccount, EmailTakenError, InvalidSignupInputError } from "@/server/services/signup-service"

export type AuthFormState = { error: string | null }

const TOO_MANY = "Too many attempts. Please wait a few minutes and try again."
const field = (data: FormData, name: string) => {
  const value = data.get(name)
  return typeof value === "string" ? value : ""
}

// signIn throws a NEXT_REDIRECT only when `redirect` is true; with false it signals failure by throwing AuthError.
async function signInWithPassword(email: string, password: string): Promise<AuthFormState | null> {
  try {
    await signIn("credentials", { email, password, redirect: false })
    return null
  } catch (error) {
    if (!(error instanceof AuthError)) throw error
    const code = (error as AuthError & { code?: string }).code
    return { error: code === "rate_limited" ? TOO_MANY : "Incorrect email or password." }
  }
}

export async function loginAction(_previous: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const failure = await signInWithPassword(field(formData, "email"), field(formData, "password"))
  if (failure) return failure
  redirect("/")
}

export async function signupAction(_previous: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = field(formData, "email")
  const password = field(formData, "password")

  const attempt = await consumeSignupAttempt(clientIp(await headers()), email)
  if (!attempt.allowed) return { error: TOO_MANY }

  try {
    await createAccount({ email, password })
  } catch (error) {
    if (error instanceof EmailTakenError) return { error: "An account with this email already exists." }
    if (error instanceof InvalidSignupInputError) return { error: error.message }
    // Cannot happen: signup does not take a timezone from the form. Never leak the message of anything else.
    if (error instanceof InvalidTimezoneError) return { error: "Could not create the account." }
    throw error
  }

  const failure = await signInWithPassword(email, password)
  redirect(failure ? "/login" : "/")
}
