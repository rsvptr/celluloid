-- Better Auth's two-factor plugin writes these on every sign-in verification
-- (reset on success, atomic increment on failure). Without them Prisma rejected
-- the write, so a correct TOTP code returned 500 and 2FA sign-in was impossible
-- once the credential session was gone — enabling 2FA was a one-way lockout.

-- AlterTable
ALTER TABLE "twoFactor" ADD COLUMN     "failedVerificationCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);
