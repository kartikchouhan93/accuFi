// The single bigint <-> string boundary for paise (JSON, URLs, form fields). Named functions rather than
// inline conversions so every crossing is greppable.
import type { Paise } from "@/domain/money"

export function serialisePaise(amount: Paise): string {
  return String(amount)
}

export function deserialisePaise(value: string): Paise {
  // BigInt() alone would accept "", " 12 ", "0x10" and "1e3"-style oddities; only plain integers pass.
  if (!/^-?\d+$/.test(value)) {
    throw new RangeError(`Cannot deserialise "${value}" as integer paise`)
  }
  return BigInt(value)
}
