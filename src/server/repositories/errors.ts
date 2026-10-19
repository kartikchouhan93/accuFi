import type { Transaction } from "@prisma/client"

// Thrown by the repositories when a row does not exist *for this user*. There is deliberately one error for both
// "no such row" and "someone else's row": a distinct "forbidden" would confirm to a prober that the id exists.
// The message never contains the id.
export class NotFoundError extends Error {
  constructor(readonly entity: "node" | "transaction" | "group") {
    super(`${entity} not found`)
    this.name = "NotFoundError"
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
