-- 01_schema.sql — schema, extension, database settings, controlled clock.
-- Runs as the administrator (needs CREATE on the database); objects are then
-- created as payrail_owner (db/build.sh issues SET ROLE after this file).

CREATE SCHEMA payrail AUTHORIZATION payrail_owner;

-- pgcrypto: bcrypt-compatible crypt()/gen_salt('bf') for seeded demo users
-- (DEC-002). Lives in `public`, not in our schema.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

-- Database-wide defaults: business dates are Asia/Kolkata (DEC-009);
-- the app role resolves unqualified names in our schema.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone = %L', current_database(), 'Asia/Kolkata');
  EXECUTE format('ALTER ROLE payrail_app IN DATABASE %I SET search_path = payrail', current_database());
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO payrail_app', current_database());
  EXECUTE format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO payrail_owner', current_database());
END
$$;

SET ROLE payrail_owner;
SET search_path = payrail;

-- Functions created by payrail_owner are NOT executable by PUBLIC unless
-- 99_privileges.sql grants them explicitly (PostgreSQL's default is PUBLIC).
ALTER DEFAULT PRIVILEGES FOR ROLE payrail_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- fn_now(): the single source of "current time" for every PayRail default
-- and workflow (DEC-015). A session may set `payrail.clock` to a timestamp,
-- but it is honoured only when the *login* (session_user) is a member of
-- payrail_owner — i.e. the seed/demo administrator. The backend logs in as
-- payrail_app, so it cannot backdate anything; for it this is now().
CREATE FUNCTION fn_now() RETURNS timestamptz
LANGUAGE plpgsql STABLE
SET search_path = payrail, pg_temp
AS $$
DECLARE
  v_clock text := current_setting('payrail.clock', true);
BEGIN
  IF v_clock IS NOT NULL AND v_clock <> ''
     AND pg_has_role(session_user, 'payrail_owner', 'MEMBER') THEN
    RETURN v_clock::timestamptz;
  END IF;
  RETURN now();
END
$$;

RESET ROLE;
