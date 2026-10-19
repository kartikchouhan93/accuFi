import { redirect } from "next/navigation"
import { auth } from "@/server/auth"
import { signupAction } from "../actions"
import { AuthForm } from "../auth-form"

export default async function SignupPage() {
  if ((await auth())?.user?.id) redirect("/")
  return <AuthForm mode="signup" action={signupAction} />
}
