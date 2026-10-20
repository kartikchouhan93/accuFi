/** The one canonical form of an email: accounts, logins and rate-limit keys all compare this, never the raw input. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}
