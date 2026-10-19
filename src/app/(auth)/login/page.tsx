import { redirect } from "next/navigation"
import { auth } from "@/server/auth"
import { loginAction } from "../actions"
import { AuthForm } from "../auth-form"

export default async function LoginPage() {
  if ((await auth())?.user?.id) redirect("/")
  return <AuthForm mode="login" action={loginAction} />
}
