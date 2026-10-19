import { describe, expect, it } from "vitest"
import { LedgerKind as PrismaLedgerKind, SystemNodeRole as PrismaSystemNodeRole } from "@prisma/client"
import type { LedgerKind, SystemNodeRole } from "@/domain/ledger-kind"

// src/domain may not import @prisma/client, so LedgerKind and SystemNodeRole exist twice: as domain unions
// and as Prisma enums. This file lives outside src/domain, where it may see both, and pins them to each
// other in both directions.
//
// The domain unions are types only, so each is mirrored below as a `Record<Union, true>`. `satisfies`
// makes `tsc` reject a member missing from the mirror or an extra one in it; the runtime assertions then
// compare the mirror's keys to the Prisma enum's values, which catches a Prisma enum that has drifted.

const DOMAIN_LEDGER_KINDS = {
  INCOME_SOURCE: true,
  ASSET: true,
  INVESTMENT: true,
  EXPENSE: true,
  LIABILITY: true,
} satisfies Record<LedgerKind, true>

const DOMAIN_SYSTEM_NODE_ROLES = {
  OPENING_BALANCE: true,
  REALISED_GAIN: true,
  REALISED_LOSS: true,
} satisfies Record<SystemNodeRole, true>

// Compile-time equality of the Prisma enum's type with the domain union (fails `tsc` on any drift).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type PrismaValue<E> = E[keyof E]
const kindTypesEqual: Equal<PrismaValue<typeof PrismaLedgerKind>, LedgerKind> = true
const roleTypesEqual: Equal<PrismaValue<typeof PrismaSystemNodeRole>, SystemNodeRole> = true

const sorted = (values: Iterable<string>) => [...values].sort()

describe("Prisma enums match the domain unions", () => {
  it("LedgerKind has exactly the domain's members", () => {
    const prisma = sorted(Object.values(PrismaLedgerKind))
    const domain = sorted(Object.keys(DOMAIN_LEDGER_KINDS))
    expect(prisma.filter((v) => !domain.includes(v)), "in Prisma but not in the domain").toEqual([])
    expect(domain.filter((v) => !prisma.includes(v)), "in the domain but not in Prisma").toEqual([])
    expect(prisma).toEqual(domain)
    expect(kindTypesEqual).toBe(true)
  })

  it("SystemNodeRole has exactly the domain's members", () => {
    const prisma = sorted(Object.values(PrismaSystemNodeRole))
    const domain = sorted(Object.keys(DOMAIN_SYSTEM_NODE_ROLES))
    expect(prisma.filter((v) => !domain.includes(v)), "in Prisma but not in the domain").toEqual([])
    expect(domain.filter((v) => !prisma.includes(v)), "in the domain but not in Prisma").toEqual([])
    expect(prisma).toEqual(domain)
    expect(roleTypesEqual).toBe(true)
  })
})
