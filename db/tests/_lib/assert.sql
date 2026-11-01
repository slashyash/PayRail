-- Test-only assertion helper (created by the administrator in the throwaway
-- test database; never part of the real schema).
CREATE OR REPLACE FUNCTION public.t_assert(ok boolean, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION 'assertion failed: %', msg USING ERRCODE = 'PT001';
  END IF;
END $$;
