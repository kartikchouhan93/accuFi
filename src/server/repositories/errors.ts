import type { Transaction } from "@prisma/client"

// Thrown by the repositories when a row does not exist *for this user*. There is deliberately one error for both
// "no such row" and "someone else's row": a distinct "forbidden" would confirm to a prober that the id exists.
// The message never contains the id.
export class NotFoundError extends Error {
  constructor(readonly entity: "node" | "transaction" | "group" | "lot" | "price" | "rule" | "occurrence") {
    super(`${entity} not found`)
    this.name = "NotFoundError"
  }
}

// The *authenticated* user has no row: a session (a JWT, which cannot be revoked) that outlived its user. Not a
// NotFoundError on purpose: that one means "the thing you asked for is not yours or not there" and is answered with
// not-found, while this one means the session is dead and is answered by sending the caller to /login
// (redirectIfUnauthenticated). Keeping them apart means neither can be mistaken for the other by an instanceof check.
export class UserNotFoundError extends Error {
  constructor() {
    super("user not found")
    this.name = "UserNotFoundError"
  }
}

// A pagination cursor that this repository did not issue (malformed or tampered with).
export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid pagination cursor")
    this.name = "InvalidCursorError"
  }
}

// An insert repeated an idempotency key this user already used: a retry of a request that already succeeded. Carries
// the stored row (the user's own; the lookup is scoped like every other) so the caller can answer with it. It may be
// a soft-deleted one, since the key stays reserved.
export class DuplicateIdempotencyKeyError extends Error {
  constructor(readonly existing: Transaction) {
    super("A transaction with this idempotency key already exists")
    this.name = "DuplicateIdempotencyKeyError"
  }
}
