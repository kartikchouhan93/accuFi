import { flashChannel } from "@/app/flash"

// The Budgets screen's channel, apart from Recurring's: the budget form saves and goes to /budgets, which says what was done.
export const { leaveFlash, takeFlash, useFlash } = flashChannel("accufi:budgets-flash")
