-- Better Auth's session and account tables index only their unique columns.
-- Session listing/revocation (Settings "Devices") and the user-delete cascade
-- both filter on userId; these are the two FK columns in the schema that had
-- no covering index (AUDIT.md finding API-8).

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");
