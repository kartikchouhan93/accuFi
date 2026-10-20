-- Give every existing user the Opening Balance Contra system node that signup now seeds for new ones. Idempotent: a user
-- that already has one (unique on userId + systemRole) is skipped. The id is a UUID string; ids are opaque text.
INSERT INTO "LedgerNode" ("id", "userId", "kind", "name", "systemRole")
SELECT gen_random_uuid()::text, u."id", 'EXPENSE', 'Opening Balance Contra', 'OPENING_BALANCE_CONTRA'
FROM "User" u
WHERE NOT EXISTS (
  SELECT 1 FROM "LedgerNode" n WHERE n."userId" = u."id" AND n."systemRole" = 'OPENING_BALANCE_CONTRA'
);
