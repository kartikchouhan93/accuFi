-- consumeAttempt always supplies windowStart (from the database clock), so the column needs no default.
ALTER TABLE "RateLimitCounter" ALTER COLUMN "windowStart" DROP DEFAULT;

-- Serves the sweep that deletes counters whose window has ended.
CREATE INDEX "RateLimitCounter_windowStart_idx" ON "RateLimitCounter"("windowStart");
