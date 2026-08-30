-- ACC-08 / INT-04 / INT-07: a confirmed journal is part of the books. Rows are never
-- edited or deleted; a correction is a reversing entry. The guard fires only for entries
-- that have been confirmed, so a draft can still be edited before it becomes a record.
CREATE OR REPLACE FUNCTION erp_forbid_confirmed_journal() RETURNS trigger AS $$
DECLARE
  entry_status text;
  target_id text;
BEGIN
  target_id := COALESCE(NEW."entryId", OLD."entryId");
  SELECT status INTO entry_status FROM "JournalEntry" WHERE id = target_id;
  IF entry_status IN ('CONFIRMED', 'CANCELED') THEN
    RAISE EXCEPTION 'confirmed journal % is append-only: % is forbidden (ACC-08/INT-07)', target_id, TG_OP
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "erp_journal_line_guard" ON "JournalLine";
CREATE TRIGGER "erp_journal_line_guard" BEFORE UPDATE OR DELETE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION erp_forbid_confirmed_journal();

-- A confirmed entry may only move to CANCELED, and never change its amounts or its date.
CREATE OR REPLACE FUNCTION erp_guard_journal_entry() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('CONFIRMED', 'CANCELED') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'confirmed journal entry % cannot be deleted (ACC-08)', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
    IF NEW."totalDebit" <> OLD."totalDebit"
       OR NEW."totalCredit" <> OLD."totalCredit"
       OR NEW."entryDate" <> OLD."entryDate" THEN
      RAISE EXCEPTION 'confirmed journal entry % cannot change amounts or date (ACC-08)', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
    IF OLD.status = 'CANCELED' AND NEW.status <> 'CANCELED' THEN
      RAISE EXCEPTION 'canceled journal entry % cannot be revived (INT-02)', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "erp_journal_entry_guard" ON "JournalEntry";
CREATE TRIGGER "erp_journal_entry_guard" BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION erp_guard_journal_entry();
