-- 03_ledger.sql — double-entry ledger machinery (DBD BR1, BR2; DEC-006).
--
--  (1) Seal:     a journal entry may receive lines only inside the transaction
--                that created its header. Once that transaction commits the
--                entry is "posted" and nothing can be appended later.
--  (2) Balance:  deferred constraint triggers on BOTH tables check at COMMIT
--                that every touched entry has >= 2 lines and Σdebit = Σcredit.
--                The header-side trigger is what rejects an empty header.
--  (3) Append-only: UPDATE/DELETE/TRUNCATE on either table raise an error.
--  (4) Privileges (11_privileges.sql): payrail_app cannot write these tables
--                at all; postings happen only inside workflow functions.
--
-- Error codes (SQLSTATE) used here, mapped to HTTP errors by the backend:
--   PRL01 entry unbalanced / fewer than 2 lines   PRL02 ledger is append-only
--   PRL03 entry already posted (seal)             PRL04 invalid posting request

SET ROLE payrail_owner;
SET search_path = payrail;

-- ---------------------------------------------------------------- (1) seal
CREATE FUNCTION trg_journal_entries_seal() RETURNS trigger
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
BEGIN
  NEW.created_xid := pg_current_xact_id();   -- cannot be spoofed by the caller
  RETURN NEW;
END $$;

CREATE TRIGGER trg_journal_entries_seal
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION trg_journal_entries_seal();

CREATE FUNCTION trg_ledger_lines_sealed() RETURNS trigger
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
DECLARE
  v_xid xid8;
BEGIN
  SELECT created_xid INTO v_xid FROM journal_entries WHERE entry_id = NEW.entry_id;
  -- (missing header: let the foreign key report it)
  IF FOUND AND v_xid <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'journal entry % is already posted; lines cannot be added', NEW.entry_id
      USING ERRCODE = 'PRL03';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_ledger_lines_sealed
  BEFORE INSERT ON ledger_lines
  FOR EACH ROW EXECUTE FUNCTION trg_ledger_lines_sealed();

-- ---------------------------------------------------------------- (2) balance at COMMIT
CREATE FUNCTION fn_assert_entry_balanced(p_entry_id bigint) RETURNS void
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
DECLARE
  v_lines  integer;
  v_debit  numeric;
  v_credit numeric;
BEGIN
  SELECT count(*),
         coalesce(sum(amount_paise) FILTER (WHERE direction = 'D'), 0),
         coalesce(sum(amount_paise) FILTER (WHERE direction = 'C'), 0)
    INTO v_lines, v_debit, v_credit
    FROM ledger_lines
   WHERE entry_id = p_entry_id;

  IF v_lines < 2 THEN
    RAISE EXCEPTION 'journal entry % has % line(s); at least 2 are required', p_entry_id, v_lines
      USING ERRCODE = 'PRL01';
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits %', p_entry_id, v_debit, v_credit
      USING ERRCODE = 'PRL01';
  END IF;
END $$;

CREATE FUNCTION trg_journal_entries_balanced() RETURNS trigger
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
BEGIN
  PERFORM fn_assert_entry_balanced(NEW.entry_id);
  RETURN NULL;
END $$;

CREATE FUNCTION trg_ledger_lines_balanced() RETURNS trigger
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
BEGIN
  PERFORM fn_assert_entry_balanced(NEW.entry_id);
  RETURN NULL;
END $$;

-- DEFERRABLE INITIALLY DEFERRED: lines are inserted one by one, so the entry
-- is only complete at COMMIT (DBD D4).
CREATE CONSTRAINT TRIGGER trg_journal_entries_balanced
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_journal_entries_balanced();

CREATE CONSTRAINT TRIGGER trg_ledger_lines_balanced
  AFTER INSERT ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_ledger_lines_balanced();

-- ---------------------------------------------------------------- (3) append-only
CREATE FUNCTION trg_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not allowed: the ledger is append-only (post a reversal instead)',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'PRL02';
END $$;

CREATE TRIGGER trg_journal_entries_no_update_delete
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION trg_ledger_append_only();
CREATE TRIGGER trg_journal_entries_no_truncate
  BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION trg_ledger_append_only();
CREATE TRIGGER trg_ledger_lines_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_lines
  FOR EACH ROW EXECUTE FUNCTION trg_ledger_append_only();
CREATE TRIGGER trg_ledger_lines_no_truncate
  BEFORE TRUNCATE ON ledger_lines
  FOR EACH STATEMENT EXECUTE FUNCTION trg_ledger_append_only();

-- ---------------------------------------------------------------- posting helper
-- One line of a posting request. Callers build an array of these.
CREATE TYPE posting_line AS (
  account_id   bigint,
  direction    char(1),
  amount_paise bigint
);

-- fn_post_entry: insert one journal entry and its lines in the CALLER's
-- transaction. Not SECURITY DEFINER and not executable by payrail_app:
-- only owner-level workflow functions (Task 2) call it, so the app cannot
-- post arbitrary entries.
--   * lines with amount 0 are dropped (e.g. a zero gateway fee, DEC-007);
--   * a negative amount is posted on the opposite side (DEC-005 rule 2);
--   * lines for the same (account, direction) are summed into one line;
--   * balance and the 2-line minimum are checked by the deferred triggers
--     at COMMIT, not here.
CREATE FUNCTION fn_post_entry(
  p_entry_type        text,
  p_description       text,
  p_lines             posting_line[],
  p_payment_id        bigint DEFAULT NULL,
  p_refund_id         bigint DEFAULT NULL,
  p_payout_id         bigint DEFAULT NULL,
  p_settlement_id     bigint DEFAULT NULL,
  p_reverses_entry_id bigint DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SET search_path = payrail, pg_temp AS $$
DECLARE
  v_entry_id bigint;
BEGIN
  IF p_lines IS NULL OR cardinality(p_lines) = 0 THEN
    RAISE EXCEPTION 'posting request has no lines' USING ERRCODE = 'PRL04';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_lines) l
              WHERE l.account_id IS NULL OR l.amount_paise IS NULL
                 OR l.direction IS NULL OR l.direction NOT IN ('D', 'C')) THEN
    RAISE EXCEPTION 'posting request has an incomplete or invalid line' USING ERRCODE = 'PRL04';
  END IF;

  INSERT INTO journal_entries (entry_type, description, payment_id, refund_id,
                               payout_id, settlement_id, reverses_entry_id)
  VALUES (p_entry_type, p_description, p_payment_id, p_refund_id,
          p_payout_id, p_settlement_id, p_reverses_entry_id)
  RETURNING entry_id INTO v_entry_id;

  INSERT INTO ledger_lines (entry_id, line_no, account_id, direction, amount_paise)
  SELECT v_entry_id,
         row_number() OVER (ORDER BY first_pos),
         account_id, direction, amount
    FROM (SELECT account_id, direction, sum(amount)::bigint AS amount, min(pos) AS first_pos
            FROM (SELECT t.account_id,
                         CASE WHEN t.amount_paise > 0 THEN t.direction
                              WHEN t.direction = 'D' THEN 'C' ELSE 'D' END AS direction,
                         abs(t.amount_paise) AS amount,
                         t.pos
                    FROM unnest(p_lines) WITH ORDINALITY AS t(account_id, direction, amount_paise, pos)
                   WHERE t.amount_paise <> 0) normalised
           GROUP BY account_id, direction) grouped;

  RETURN v_entry_id;
END $$;

RESET ROLE;
