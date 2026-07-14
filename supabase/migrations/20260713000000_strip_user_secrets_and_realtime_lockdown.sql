-- C1: Remove password hashes from JSONB user documents and lock down Realtime exposure.
-- Source of truth for credentials remains Firebase Authentication.
-- Rollback notes at bottom of this file.

-- 1) Strip sensitive keys from documents.collection = 'users'
UPDATE documents
SET
  data = data
    - 'password'
    - 'password_hash'
    - 'passwordHash'
    - 'hashedPassword'
    - 'hash'
    - 'currentPassword'
    - 'newPassword'
    - 'plainPassword'
    - 'tempPassword'
    - 'resetToken'
    - 'reset_token'
    - 'refreshToken'
    - 'refresh_token'
    - 'idToken'
    - 'id_token',
  updated_at = now()
WHERE collection = 'users'
  AND (
    data ? 'password'
    OR data ? 'password_hash'
    OR data ? 'passwordHash'
    OR data ? 'hashedPassword'
    OR data ? 'hash'
    OR data ? 'currentPassword'
    OR data ? 'newPassword'
    OR data ? 'plainPassword'
    OR data ? 'tempPassword'
    OR data ? 'resetToken'
    OR data ? 'reset_token'
    OR data ? 'refreshToken'
    OR data ? 'refresh_token'
    OR data ? 'idToken'
    OR data ? 'id_token'
  );

-- 2) Strip sensitive keys from dedicated users.source_document (+ clear password_hash column)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'users'
  ) THEN
    UPDATE users
    SET
      password_hash = NULL,
      source_document = COALESCE(source_document, '{}'::jsonb)
        - 'password'
        - 'password_hash'
        - 'passwordHash'
        - 'hashedPassword'
        - 'hash'
        - 'currentPassword'
        - 'newPassword'
        - 'plainPassword'
        - 'tempPassword'
        - 'resetToken'
        - 'reset_token'
        - 'refreshToken'
        - 'refresh_token'
        - 'idToken'
        - 'id_token',
      updated_at = now()
    WHERE password_hash IS NOT NULL
       OR source_document ? 'password'
       OR source_document ? 'password_hash'
       OR source_document ? 'passwordHash'
       OR source_document ? 'hashedPassword'
       OR source_document ? 'hash'
       OR source_document ? 'currentPassword'
       OR source_document ? 'newPassword'
       OR source_document ? 'plainPassword'
       OR source_document ? 'tempPassword'
       OR source_document ? 'resetToken'
       OR source_document ? 'reset_token'
       OR source_document ? 'refreshToken'
       OR source_document ? 'refresh_token'
       OR source_document ? 'idToken'
       OR source_document ? 'id_token';
  END IF;
END $$;

-- 3) Realtime: authenticated clients must not SELECT the users table
DROP POLICY IF EXISTS realtime_read_users ON users;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'users'
     ) THEN
    EXECUTE 'REVOKE ALL ON TABLE public.users FROM authenticated';
    EXECUTE 'REVOKE ALL ON TABLE public.users FROM anon';
    DROP POLICY IF EXISTS deny_anon_users ON users;
    CREATE POLICY deny_anon_users ON users
      FOR ALL TO anon, authenticated
      USING (false)
      WITH CHECK (false);
  END IF;
END $$;

-- 4) Realtime documents policy: exclude user collection rows (packing tables still readable)
DROP POLICY IF EXISTS realtime_read_documents ON documents;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
    CREATE POLICY realtime_read_documents ON documents
      FOR SELECT TO authenticated
      USING (
        (auth.jwt() ->> 'app_user_id') IS NOT NULL
        AND collection IS DISTINCT FROM 'users'
      );
  END IF;
END $$;

-- 5) Remove users table from supabase_realtime publication when present
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'users'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.users';
  END IF;
END $$;

-- Rollback (manual):
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
--   DROP POLICY IF EXISTS realtime_read_documents ON documents;
--   CREATE POLICY realtime_read_documents ON documents
--     FOR SELECT TO authenticated
--     USING ((auth.jwt() ->> 'app_user_id') IS NOT NULL);
--   CREATE POLICY realtime_read_users ON users
--     FOR SELECT TO authenticated
--     USING ((auth.jwt() ->> 'app_user_id') IS NOT NULL);
-- Note: password hashes cannot be restored after this migration (Firebase Auth remains authoritative).
