/**
 * The client address used to key rate limits. Takes the LAST X-Forwarded-For entry: that is the one appended by
 * the nearest reverse proxy, i.e. the peer address that proxy actually saw. Earlier entries are whatever the
 * client chose to send and are trivially forged. With no proxy in front there is no trustworthy address, so the
 * result is "unknown" (or a forged value the client controls); deploy behind a proxy that sets this header.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",").pop()?.trim()
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown"
}
