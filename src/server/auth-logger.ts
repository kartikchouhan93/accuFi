// Auth.js's default logger prints every error it handles with a stack trace, including CredentialsSignin, which it
// throws for each wrong password and unknown email (and RateLimitedSignin, a subclass, for each lockout). Those are
// routine answers, so they are skipped here. They are recognised by `type`, which a subclass inherits, rather than by
// class, so the check does not depend on which copy of the class a bundle holds. Everything else, including a database or argon2 failure inside `authorize`
// (Auth.js wraps it in a CallbackRouteError), is printed the way the default logger prints it, because the operator
// has to see it. `warn` and `debug` are left out on purpose: Auth.js keeps its own for any level not overridden.
export const authLogger = {
  error(error: Error): void {
    const type = "type" in error && typeof error.type === "string" ? error.type : null
    if (type === "CredentialsSignin") return
    const name = type ?? error.name
    console.error(`[auth][error] ${name}: ${error.message}`)
    const cause = error.cause
    if (typeof cause === "object" && cause !== null && "err" in cause && cause.err instanceof Error) {
      console.error("[auth][cause]:", cause.err.stack)
    } else if (error.stack) {
      console.error(error.stack.replace(/.*/, "").substring(1))
    }
  },
}
