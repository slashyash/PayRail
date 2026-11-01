-- 06_system_accounts.sql — chart of accounts, system part (DEC-007).
-- Vendor payable accounts are created per vendor by trg_vendors_create_payable.
--
--   code                 owner     class      normal  used by
--   GATEWAY_CLEARING     gateway   asset      D       capture (D), refund (C), settlement (C / D)
--   BANK                 bank      asset      D       settlement (D / C), payout (C), payout reversal (D)
--   COMMISSION_REVENUE   platform  revenue    C       capture (C), refund (D)
--   GATEWAY_FEE_EXPENSE  platform  expense    D       settlement fee (D)
--   GST_PAYABLE          tax       liability  C       capture (C), refund (D)

SET ROLE payrail_owner;
SET search_path = payrail;

INSERT INTO accounts (code, owner_type, vendor_id, account_class) VALUES
  ('GATEWAY_CLEARING',    'gateway',  NULL, 'asset'),
  ('BANK',                'bank',     NULL, 'asset'),
  ('COMMISSION_REVENUE',  'platform', NULL, 'revenue'),
  ('GATEWAY_FEE_EXPENSE', 'platform', NULL, 'expense'),
  ('GST_PAYABLE',         'tax',      NULL, 'liability');

RESET ROLE;
