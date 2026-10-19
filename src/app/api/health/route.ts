import { NextResponse } from "next/server"
import { prisma } from "@/server/db"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`
    return NextResponse.json({ status: "ok", database: "up" })
  } catch {
    return NextResponse.json({ status: "error", database: "down" }, { status: 503 })
  }
}
