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

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:border-zinc-300"

export function AuthForm({ mode, action }: Props) {
  const [state, formAction, pending] = useActionState(action, { error: null })
  const copy = COPY[mode]
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <form action={formAction} className="w-full max-w-sm space-y-4 rounded-lg bg-white p-6 shadow dark:bg-zinc-950">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{copy.title}</h1>
        <label className="block space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
          Email
          <input name="email" type="email" required autoComplete="email" maxLength={254} className={inputClass} />
        </label>
        <label className="block space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
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
          {mode === "signup" && <span className="text-xs text-zinc-500">At least 8 characters.</span>}
        </label>
        {state.error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-zinc-900 px-3 py-2 font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {pending ? "Please wait..." : copy.submit}
        </button>
        <p className="text-center text-sm text-zinc-600 dark:text-zinc-400">
          {copy.altText}{" "}
          <Link href={copy.altHref} className="font-medium underline">
            {copy.altLabel}
          </Link>
        </p>
      </form>
    </main>
  )
}
