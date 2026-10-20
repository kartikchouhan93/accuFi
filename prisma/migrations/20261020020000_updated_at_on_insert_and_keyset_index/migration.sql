-- EC-66, correcting 20261019230000_updated_at_trigger. That migration assumed the column default stamps updatedAt on
-- INSERT. It does not: Prisma's `@updatedAt` supplies a value on create, so the default never fires and every row was
-- inserted with the app process's clock. Make the trigger fire on INSERT too, so the database clock wins whatever
-- the statement (Prisma, raw SQL, an import) supplied. The trigger function is unchanged.
DROP TRIGGER "Transaction_set_updated_at" ON "Transaction";
CREATE TRIGGER "Transaction_set_updated_at"
BEFORE INSERT OR UPDATE ON "Transaction"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Transaction listings sort by (occurredAt, id) within a user and page by keyset on that pair. Adding id to the index
-- lets Postgres read the order straight off it (backwards for newest-first) instead of sorting ties. The old
-- (userId, occurredAt) index is a prefix of this one, so it is dropped.
CREATE INDEX "Transaction_userId_occurredAt_id_idx" ON "Transaction"("userId", "occurredAt", "id");
DROP INDEX "Transaction_userId_occurredAt_idx";
