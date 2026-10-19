// Development convenience: create one account, with its system nodes and starter ledgers, through the same
// createAccount() the signup page uses. Credentials come from the environment so no password is committed:
//   SEED_EMAIL=you@example.com SEED_PASSWORD='a long password' bunx prisma db seed
import { prisma } from "../src/server/db"
import { createAccount, EmailTakenError } from "../src/server/services/signup-service"

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed a production database")
  const email = process.env.SEED_EMAIL
  const password = process.env.SEED_PASSWORD
  if (!email || !password) throw new Error("Set SEED_EMAIL and SEED_PASSWORD to seed an account")
  try {
    const { userId } = await createAccount({ email, password })
    console.log(`Created account ${email} (${userId})`)
  } catch (error) {
    if (!(error instanceof EmailTakenError)) throw error
    console.log(`Account ${email} already exists; nothing to do`)
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
