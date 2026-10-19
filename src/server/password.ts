import { hash, verify } from "@node-rs/argon2"

// argon2id via @node-rs/argon2's defaults (19 MiB memory, 2 passes, 1 lane: the OWASP minimum) with a fresh random
// salt per hash. argon2id is the library default; its `Algorithm` enum cannot be imported under isolatedModules,
// so password.test.ts pins the "$argon2id$" prefix instead. Salt and parameters are encoded in the hash string,
// so verify needs nothing else. This is the only file that knows which argon2 implementation is in use.

export function hashPassword(plain: string): Promise<string> {
  return hash(plain)
}

/** True only when `plain` matches `hash`. A malformed stored hash is a failed match, not an exception. */
export async function verifyPassword(plain: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain)
  } catch {
    return false
  }
}
