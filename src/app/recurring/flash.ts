import { flashChannel } from "@/app/flash"

// The Recurring screen's channel: the rule form saves and goes to /recurring, which says what was done.
export const { leaveFlash, takeFlash, useFlash } = flashChannel("accufi:recurring-flash")
export type { Flash } from "@/app/flash"
