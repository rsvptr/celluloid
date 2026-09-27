-- Server-side backstop for abandoned transactions (NE-12). If a function
-- instance is frozen or killed mid-transaction, Prisma's in-process timeout
-- never fires and the transaction's FOR UPDATE locks outlive it. Postgres now
-- ends a session of this role once it has sat idle inside a transaction for
-- 60 s, longer than any Prisma transaction timeout (45 s at most). Only idle
-- time counts, so long queries and DDL are unaffected.
--
-- A role setting applies to sessions that start after it, not to open ones,
-- such as server connections Neon's pooler already holds. It lands on
-- CURRENT_USER, the role running migrations; if the app connects as another
-- role, set it there by hand. `prisma migrate diff` does not compare role
-- settings, so the drift check neither needs nor sees this.
--
-- A role that may not change its own settings gets a NOTICE, not a failed
-- deploy.
DO $$
BEGIN
  ALTER ROLE CURRENT_USER SET idle_in_transaction_session_timeout = '60s';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipped setting idle_in_transaction_session_timeout for role %: %', current_user, SQLERRM;
END
$$;
