"use server"

import { signOut } from "@/server/auth"

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" })
}
