// The message the screen shows after something happened. `lines` are separate paragraphs: what was done first, then
// anything the user should know about the state it left (a warning is information, not a failure), and `undo` is
// offered when the action can be taken back.

export interface TransactionNotice {
  tone: "success" | "warning"
  lines: string[]
  undo?: { label: string; run: () => void }
}

export type Announce = (notice: TransactionNotice, moveFocus?: boolean) => void
