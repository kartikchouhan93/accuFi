-- AlterEnum
-- A negative opening position (a card already owed on, an overdrawn account) is posted node -> this per-user EXPENSE
-- system node, because INCOME_SOURCE can never be a transaction target. The row for existing users is the next migration:
-- PostgreSQL does not let a newly added enum value be used in the transaction that adds it.
ALTER TYPE "SystemNodeRole" ADD VALUE 'OPENING_BALANCE_CONTRA';
