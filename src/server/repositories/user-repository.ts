import { prisma } from "@/server/db"
import { UserNotFoundError } from "./errors"

// The only user-row reads the services need. The lookup key is the user's own id, so it is
// scoped by construction: there is no way to ask for another user's row by passing a different id than your own.

/** The user's IANA timezone, or null if there is no such user. */
export async function findUserTimezone(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } })
  return user?.timezone ?? null
}

/**
 * How many days old a price may be before it is flagged stale (spec §7.3, EC-24), unless a node overrides it. Throws
 * UserNotFoundError for an id that is not a user, as `todayFor` does: the caller's session outlived its user.
 */
export async function findStalePriceDays(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { stalePriceDays: true } })
  if (!user) throw new UserNotFoundError()
  return user.stalePriceDays
}
