import { describe, it, expect } from "vitest"
import { ESLint } from "eslint"

// Lints source strings as if they lived in src/domain, using the project's real eslint config,
// so the purity / no-float-money rules cannot silently regress.
const eslint = new ESLint({ cwd: process.cwd() })

async function violations(source: string, file = "src/domain/probe.ts") {
  const [result] = await eslint.lintText(source, { filePath: file })
  return result.messages.filter((m) => m.ruleId?.startsWith("no-restricted-"))
}

describe("domain purity: restricted imports", () => {
  it.each([
    ['import { PrismaClient } from "@prisma/client"', "@prisma/client"],
    ['import type { Prisma } from "@prisma/client"', "type import of @prisma/client"],
    ['import { NextResponse } from "next/server"', "next/*"],
    ['import next from "next"', "next"],
    ['import { prisma } from "../server/db"', "../server/*"],
    ['import { prisma } from "../../server/db"', "../../server/*"],
    ['import { y } from "../../../server/db"', "three levels deep"],
    ['import { prisma } from "@/server/db"', "@/server alias"],
  ])("rejects %s (%s)", async (source) => {
    const found = await violations(`${source}\nexport {}\n`)
    expect(found.map((m) => m.ruleId)).toContain("no-restricted-imports")
  })

  it.each([
    ['import { z } from "zod"'],
    ['import { x } from "./money"'],
    ['import { x } from "@/domain/money"'],
    ['import { x } from "../lib/format"'],
  ])("allows %s", async (source) => {
    expect(await violations(`${source}\nexport {}\n`)).toEqual([])
  })

  it("does not apply outside src/domain", async () => {
    const found = await violations(
      'import { prisma } from "@/server/db"\nexport {}\n',
      "src/app/probe.ts",
    )
    expect(found).toEqual([])
  })
})

describe("domain purity: no float path for money", () => {
  it.each([
    "export const a = (amountPaise: string) => parseFloat(amountPaise)",
    "export const a = (row: { amount: string }) => parseFloat(row.amount)",
    "export const a = (amountPaise: string) => Number.parseFloat(amountPaise)",
    "export const a = (amountPaise: string) => Number.parseInt(amountPaise)",
    "export const a = (balance: string) => Number(balance)",
    "export const a = (row: { balance: string }) => Number(row.balance)",
    "export const a = (balance: string) => +balance",
    "export const a = (row: { balance: string }) => +row.balance",
    "export const a = (paise: number) => paise.toFixed(2)",
    "export const a = (row: { paise: number }) => row.paise.toFixed(2)",
  ])("rejects %s", async (source) => {
    const found = await violations(`${source}\n`)
    expect(found.map((m) => m.ruleId)).toContain("no-restricted-syntax")
  })

  it.each([
    "export const a = (n: number) => n.toFixed(2)",
    "export const a = (s: string) => parseFloat(s)",
    "export const a = (s: string) => Number(s)",
    "export const a = (n: number) => +n",
    "export const a = (paise: bigint) => paise + 1n",
  ])("allows non-money %s", async (source) => {
    expect(await violations(`${source}\n`)).toEqual([])
  })
})
