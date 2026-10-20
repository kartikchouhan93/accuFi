"use client"

import Link from "next/link"
import { useActionState } from "react"
import type { AuthFormState } from "./actions"

type Props = {
  mode: "login" | "signup"
  action: (previous: AuthFormState, formData: FormData) => Promise<AuthFormState>
}

const COPY = {
  login: { title: "Sign in to AccuFi", submit: "Sign in", altText: "No account yet?", altHref: "/signup", altLabel: "Create one" },
  signup: { title: "Create your AccuFi account", submit: "Create account", altText: "Already have an account?", altHref: "/login", altLabel: "Sign in" },
} as const

// The same pad as the rest of the app: ink on analysis paper, the wordmark over a double rule, blue for the one thing to do.
const inputClass = "w-full rounded-sm border border-rule-strong bg-paper px-3 py-2 text-ink"

export function AuthForm({ mode, action }: Props) {
  const [state, formAction, pending] = useActionState(action, { error: null })
  const copy = COPY[mode]
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <p className="font-display text-3xl font-bold tracking-tight">AccuFi</p>
        <div className="double-rule mt-1" />
        <form action={formAction} className="mt-6 space-y-4 bg-sheet p-6">
          <h1 className="font-display text-xl font-semibold">{copy.title}</h1>
          <label className="block space-y-1 text-sm font-medium">
            Email
            <input name="email" type="email" required autoComplete="email" maxLength={254} className={inputClass} />
          </label>
          <label className="block space-y-1 text-sm font-medium">
            Password
            <input
              name="password"
              type="password"
              required
              minLength={mode === "signup" ? 8 : 1}
              maxLength={128}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              className={inputClass}
            />
            {mode === "signup" && <span className="block text-xs font-normal text-ink-soft">At least 8 characters.</span>}
          </label>
          {state.error && (
            <p role="alert" className="bg-red-wash px-3 py-2 text-sm font-medium text-red">
              {state.error}
            </p>
          )}
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-sm bg-pen px-3 py-2 font-medium text-pen-ink disabled:opacity-60"
          >
            {pending ? "Please wait..." : copy.submit}
          </button>
          <p className="text-center text-sm text-ink-soft">
            {copy.altText}{" "}
            <Link href={copy.altHref} className="font-medium text-pen underline underline-offset-4">
              {copy.altLabel}
            </Link>
          </p>
        </form>
      </div>
    </main>
  )
}
