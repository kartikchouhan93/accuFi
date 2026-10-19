import { describe, expect, it } from "vitest"
import { LedgerKind as PrismaLedgerKind, SystemNodeRole as PrismaSystemNodeRole } from "@prisma/client"
import { LEDGER_KINDS, SYSTEM_NODE_ROLES } from "@/domain/ledger-kind"

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
})
