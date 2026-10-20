-- EC-66: every server timestamp comes from the database clock. The column default covers INSERT; Prisma's
-- `@updatedAt` writes the app process's clock on UPDATE, and a raw-SQL update bypasses it entirely. This
-- trigger overwrites updatedAt with now() on every UPDATE, whatever value (or none) the statement set.
-- Hand-written: Prisma does not model triggers. Transaction is the only table with an updatedAt column.
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW."updatedAt" = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Transaction_set_updated_at"
BEFORE UPDATE ON "Transaction"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
