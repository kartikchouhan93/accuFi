// The address used to key rate limits. X-Forwarded-For is client-controlled unless a reverse proxy in front of the
// app is overwriting or appending to it, so it is IGNORED unless the operator declares how many trusted proxies
// there are: TRUSTED_PROXY_HOPS (default 0). Honouring it by default would let an attacker mint a fresh rate-limit
// window per request just by rotating the header.

function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim() ?? ""
  return /^[1-9]\d{0,2}$/.test(raw) ? Number(raw) : 0 // anything unparseable means "no proxy": fail closed
}

/**
 * With 0 trusted proxies (the default) this is always "unknown": X-Forwarded-For and X-Real-IP are not read, and
 * limits collapse to per-account, which a client cannot influence. With N >= 1, it is the Nth entry from the right
 * of X-Forwarded-For, i.e. the address the outermost trusted proxy saw; earlier entries are client-supplied. If the
 * header is shorter than the declared chain, the result is "unknown" rather than a guess.
 */
export function clientIp(headers: Headers): string {
  const hops = trustedProxyHops()
  if (hops === 0) return "unknown"
  const entries = headers.get("x-forwarded-for")?.split(",").map((entry) => entry.trim()) ?? []
  return entries.length >= hops ? entries[entries.length - hops] || "unknown" : "unknown"
}
