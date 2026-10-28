import { describe, expect, it } from "vitest"
import {
  LedgerKind as PrismaLedgerKind,
  LotMethod as PrismaLotMethod,
  PriceSource as PrismaPriceSource,
  RecurrenceFrequency as PrismaRecurrenceFrequency,
  SystemNodeRole as PrismaSystemNodeRole,
} from "@prisma/client"
import { RECURRENCE_FREQUENCIES } from "@/domain/recurrence"
import { LEDGER_KINDS, LOT_METHODS, PRICE_SOURCES, SYSTEM_NODE_ROLES } from "@/domain/ledger-kind"
import { LOT_METHODS as SCHEMA_LOT_METHODS } from "@/lib/schemas/node"

// src/domain may not import @prisma/client, so LedgerKind and SystemNodeRole exist twice: as domain unions
// (derived from the LEDGER_KINDS / SYSTEM_NODE_ROLES arrays) and as Prisma enums. This file lives outside
// src/domain, where it may see both, and compares the two lists at runtime in both directions: a member
// added, removed or renamed on either side fails `bun run test`.

const sorted = (values: readonly string[]) => [...values].sort()

function expectSameMembers(domain: readonly string[], prisma: readonly string[]) {
  expect(
    prisma.filter((v) => !domain.includes(v)),
    "in the Prisma enum but not in the domain",
  ).toEqual([])
  expect(
    domain.filter((v) => !prisma.includes(v)),
    "in the domain but not in the Prisma enum",
  ).toEqual([])
  expect(sorted(prisma)).toEqual(sorted(domain))
}

describe("Prisma enums match the domain unions", () => {
  it("LedgerKind has exactly the domain's members", () => {
    expectSameMembers(LEDGER_KINDS, Object.values(PrismaLedgerKind))
  })

  it("SystemNodeRole has exactly the domain's members", () => {
    expectSameMembers(SYSTEM_NODE_ROLES, Object.values(PrismaSystemNodeRole))
  })

  it("LotMethod has exactly the domain's members", () => {
    expectSameMembers(LOT_METHODS, Object.values(PrismaLotMethod))
  })

  it("PriceSource has exactly the domain's members", () => {
    expectSameMembers(PRICE_SOURCES, Object.values(PrismaPriceSource))
  })

  it("RecurrenceFrequency has exactly the domain's members", () => {
    expectSameMembers(RECURRENCE_FREQUENCIES, Object.values(PrismaRecurrenceFrequency))
  })

  it("the zod schema's LOT_METHODS list is the domain's list", () => {
    expectSameMembers(SCHEMA_LOT_METHODS, LOT_METHODS)
  })
})
