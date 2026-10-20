import { hash, verify } from "@node-rs/argon2"

// argon2id with a fresh random salt per hash. The work factor is stated here, not inherited, so a library upgrade
// cannot silently change it: 19 MiB memory, 2 passes, 1 lane (the OWASP minimum). Raising it later is safe, since
// each hash records its own parameters. argon2id itself is the library default; its `Algorithm` enum cannot be
// imported under isolatedModules, so password.test.ts pins the "$argon2id$v=19$m=19456,t=2,p=1$" prefix instead.
// This is the only file that knows which argon2 implementation is in use.
const COST = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, COST)
}

/**
 * True only when `plain` matches `hash`. A malformed stored hash is a failed match, not an exception.
 *
 * argon2 throws for a malformed hash and also when its native binding cannot load or run, and both are answered "no", so
 * a user is never told which. The second is not a wrong password: left silent, a broken binding looks like a login page
 * that rejects everyone. So the throw is logged at error level, with what the library said and nothing of the password or
 * the stored hash, before the generic answer is returned.
 */
export async function verifyPassword(plain: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain)
  } catch (error) {
    console.error("[verifyPassword] argon2 verification threw; answering as a failed match:", error)
    return false
  }
}
