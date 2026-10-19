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
