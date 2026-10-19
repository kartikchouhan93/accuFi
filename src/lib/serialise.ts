// The single bigint <-> string boundary for paise (JSON, URLs, form fields). Named functions rather than
// inline conversions so every crossing is greppable.
// Relative (not "@/") import: this is a value import and Vitest does not resolve the tsconfig alias.
import { MoneyParseError, type Paise } from "../domain/money"

export function serialisePaise(amount: Paise): string {
  return String(amount)
}

/** Throws MoneyParseError (same as parseRupees) so Server Actions catch one type for bad money input. */
export function deserialisePaise(value: string): Paise {
  // BigInt() alone would accept "", " 12 ", "0x10" and "1e3"-style oddities; only plain integers pass.
  if (!/^-?\d+$/.test(value)) {
    throw new MoneyParseError(`Cannot deserialise "${value}" as integer paise`)
  }
  return BigInt(value)
}
