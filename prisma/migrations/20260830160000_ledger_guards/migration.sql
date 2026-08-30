-- INT-04 / INT-07: ledger and audit rows are append-only. The application layer refuses
-- update/delete first (src/server/db.ts), these triggers are the hard guarantee.
CREATE OR REPLACE FUNCTION erp_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is forbidden (INT-04/INT-07)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['AuditLog', 'SensitiveAccessLog']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'erp_append_only_' || t, t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION erp_forbid_mutation()', 'erp_append_only_' || t, t);
  END LOOP;
END $$;

-- LeaveGrant/LeaveUsage are ledgers too; reversals are new rows.
DROP TRIGGER IF EXISTS erp_append_only_LeaveUsage ON "LeaveUsage";
CREATE TRIGGER "erp_append_only_LeaveUsage" BEFORE UPDATE OR DELETE ON "LeaveUsage"
  FOR EACH ROW EXECUTE FUNCTION erp_forbid_mutation();

DROP TRIGGER IF EXISTS erp_append_only_LeaveGrant ON "LeaveGrant";
CREATE TRIGGER "erp_append_only_LeaveGrant" BEFORE UPDATE OR DELETE ON "LeaveGrant"
  FOR EACH ROW EXECUTE FUNCTION erp_forbid_mutation();
