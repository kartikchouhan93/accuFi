import { redirect } from "next/navigation"
import { hasLiveSession } from "@/server/action-support"
import { loginAction } from "../actions"
import { AuthForm } from "../auth-form"

export default async function LoginPage() {
  if (await hasLiveSession()) redirect("/")
  return <AuthForm mode="login" action={loginAction} />
}
