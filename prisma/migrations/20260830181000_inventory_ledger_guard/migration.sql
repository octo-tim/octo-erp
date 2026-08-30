-- INV-04 / INT-04 / INT-07: InventoryLedger is the source of truth for stock on hand,
-- so its rows are append-only. A cancellation writes an opposite row; nothing is deleted
-- or edited. The application layer refuses first (src/server/db.ts); this is the guarantee.
DROP TRIGGER IF EXISTS "erp_append_only_InventoryLedger" ON "InventoryLedger";
CREATE TRIGGER "erp_append_only_InventoryLedger" BEFORE UPDATE OR DELETE ON "InventoryLedger"
  FOR EACH ROW EXECUTE FUNCTION erp_forbid_mutation();
