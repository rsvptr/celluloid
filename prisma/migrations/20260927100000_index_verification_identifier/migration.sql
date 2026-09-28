-- Better Auth declares verification.identifier as indexed, and two-factor
-- sign-in reads and consumes its challenge rows by identifier ("2fa-…",
-- "2fa-attempts-…"). Without this index each lookup scans the table.

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");
