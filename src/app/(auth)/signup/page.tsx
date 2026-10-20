import { redirect } from "next/navigation"
import { hasLiveSession } from "@/server/action-support"
import { signupAction } from "../actions"
import { AuthForm } from "../auth-form"

export default async function SignupPage() {
  if (await hasLiveSession()) redirect("/")
  return <AuthForm mode="signup" action={signupAction} />
}
