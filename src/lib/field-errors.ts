import type { ZodError } from "zod"

/** Zod issues as `{ fieldName: [messages] }`; an issue about the input as a whole is filed under "form". */
export function fieldErrorsOf(error: ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "form"
    ;(out[key] ??= []).push(issue.message)
  }
  return out
}
