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

/** True only when `plain` matches `hash`. A malformed stored hash is a failed match, not an exception. */
export async function verifyPassword(plain: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain)
  } catch {
    return false
  }
}
