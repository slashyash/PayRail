-- 00_roles.sql — cluster-level roles (DEC-013). Run by an administrator
-- (superuser or a role with CREATEROLE). Safe to re-run: roles are created
-- only if missing; the app password is (re)set from the psql variable
-- :app_password supplied by db/build.sh.
--
--   payrail_owner  NOLOGIN. Owns schema `payrail` and every object in it.
--                  SECURITY DEFINER workflow functions run with its rights.
--   payrail_app    LOGIN. Used by the backend. Never owner, never superuser;
--                  read access plus EXECUTE on workflow functions only.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payrail_owner') THEN
    CREATE ROLE payrail_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payrail_app') THEN
    CREATE ROLE payrail_app LOGIN;
  END IF;
END
$$;

-- Defensive: the app role must never be able to escalate.
ALTER ROLE payrail_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
ALTER ROLE payrail_app PASSWORD :'app_password';
