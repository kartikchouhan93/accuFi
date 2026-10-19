import { prisma } from "@/server/db"

// The only user-row read the node and transaction services need. The lookup key is the user's own id, so it is
// scoped by construction: there is no way to ask for another user's row by passing a different id than your own.

/** The user's IANA timezone, or null if there is no such user. */
export async function findUserTimezone(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } })
  return user?.timezone ?? null
}
