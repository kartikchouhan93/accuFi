"use client"

import { CircleAlert, LoaderCircle } from "lucide-react"
import Link from "next/link"
import { useActionState, useState } from "react"
import { BackgroundBeams } from "@/components/ui/background-beams"
import { buttonClass, inputClass } from "@/components/ui/styles"
import type { AuthFormState } from "./actions"

type Props = {
  mode: "login" | "signup"
  action: (previous: AuthFormState, formData: FormData) => Promise<AuthFormState>
}

const COPY = {
  login: { title: "Sign in to AccuFi", submit: "Sign in", altText: "No account yet?", altHref: "/signup", altLabel: "Create one" },
  signup: { title: "Create your AccuFi account", submit: "Create account", altText: "Already have an account?", altHref: "/login", altLabel: "Sign in" },
} as const

// The one screen with something behind it: faint beams of marigold and iris drifting across the canvas, because there is
// no data here to compete with. The form itself is a plain surface so the fields stay the clearest thing on it.
export function AuthForm({ mode, action }: Props) {
  const [state, formAction, pending] = useActionState(action, { error: null })
  // Controlled, not left to the browser: React 19 resets an uncontrolled form once its action settles, refusals included,
  // which would empty both fields after one typo. The password stays in this component and is never sent back by the server.
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const copy = COPY[mode]
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <BackgroundBeams />
      <div className="relative z-10 w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <span aria-hidden className="grid size-11 place-items-center rounded-2xl bg-accent font-display text-xl font-bold text-accent-fg">
            A
          </span>
          <p className="font-display text-2xl font-semibold tracking-tight">AccuFi</p>
        </div>
        <form action={formAction} className="surface space-y-5 rounded-3xl p-7">
          <h1 className="font-display text-2xl font-semibold tracking-tight">{copy.title}</h1>
          <label className="block space-y-1.5 text-sm font-medium">
            Email
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            Password
            <input
              name="password"
              type="password"
              required
              minLength={mode === "signup" ? 8 : 1}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              className={inputClass}
            />
            {mode === "signup" && <span className="block text-xs font-normal text-fg-soft">At least 8 characters.</span>}
          </label>
          {state.error && (
            <p role="alert" className="flex items-start gap-2.5 rounded-xl bg-negative-wash px-3.5 py-2.5 text-sm font-medium text-negative">
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{state.error}</span>
            </p>
          )}
          <button type="submit" disabled={pending} className={buttonClass({ className: "w-full" })}>
            {pending && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
            {pending ? "Please wait..." : copy.submit}
          </button>
          <p className="text-center text-sm text-fg-soft">
            {copy.altText}{" "}
            <Link href={copy.altHref} className="rounded-md font-medium text-link underline underline-offset-4">
              {copy.altLabel}
            </Link>
          </p>
        </form>
      </div>
    </main>
  )
}
