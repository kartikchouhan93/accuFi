// The idempotency key of a form submission: chosen by the browser once when a form is opened, sent with every attempt to
// submit it, so a double click or a retry after a dropped connection is one transaction, not two (EC-17).
//
// Not `crypto.randomUUID()`: that exists only in a secure context (https or localhost), and a self-hosted copy of the
// app reached over plain http on a home network has none. `getRandomValues` is available everywhere. 128 random bits,
// as hex, is well over the 16-character floor the server holds keys to.
export function newRequestKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}
