// User.timezone is a user setting, not server config, and todayIn() hands it straight to Intl, which throws an
// untyped RangeError for a bad zone. A bad stored value would therefore throw from every date calculation in the
// app. Every place that writes a timezone validates it here first, so a bad value is never stored.

export const DEFAULT_TIMEZONE = "Asia/Kolkata"

export class InvalidTimezoneError extends Error {
  constructor(timezone: unknown) {
    super(`"${String(timezone)}" is not a valid IANA timezone (expected e.g. "Asia/Kolkata")`)
    this.name = "InvalidTimezoneError"
  }
}

// Region/City (optionally Region/Area/City), or UTC. Intl on its own also accepts UTC offsets such as "+05:30"
// and abbreviations, none of which are IANA zones and none of which belong in a stored setting.
const IANA_SHAPE = /^(?:UTC|[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+){1,2})$/

/** True for a real IANA zone name that Intl can format dates in. Never throws. */
export function isValidTimezone(timezone: string): boolean {
  if (typeof timezone !== "string" || timezone.length > 64 || !IANA_SHAPE.test(timezone)) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/** Returns the zone unchanged, or throws InvalidTimezoneError. */
export function assertValidTimezone(timezone: string): string {
  if (!isValidTimezone(timezone)) throw new InvalidTimezoneError(timezone)
  return timezone
}
