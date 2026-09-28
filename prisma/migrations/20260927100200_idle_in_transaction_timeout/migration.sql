-- Server-side backstop for abandoned transactions (NE-12). If a function
-- instance is frozen or killed mid-transaction, Prisma's in-process timeout
-- never fires and the transaction's FOR UPDATE locks outlive it. Postgres now
-- ends a session of this role once it has sat idle inside a transaction for
-- 60 s, longer than any Prisma transaction timeout (45 s at most). Only idle
-- time counts, so long queries and DDL are unaffected.
--
-- A role setting applies to sessions that start after it, not to open ones,
-- such as server connections Neon's pooler already holds. It lands on
-- CURRENT_USER, the role running migrations, in this database only, so
-- replaying the migrations as a local superuser leaves its other databases
-- alone. If the app connects as another role, set it there by hand.
-- `prisma migrate diff` does not compare role settings, so the drift check
-- neither needs nor sees this.
--
-- Any error gets a NOTICE, not a failed deploy: a failed migration would block
-- every later deploy until someone resolves it by hand, and this is optional.
DO $$
BEGIN
  EXECUTE format(
    'ALTER ROLE %I IN DATABASE %I SET idle_in_transaction_session_timeout = %L',
    current_user, current_database(), '60s'
  );
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Skipped setting idle_in_transaction_session_timeout for role % in database %: % (SQLSTATE %)',
      current_user, current_database(), SQLERRM, SQLSTATE;
END
$$;
