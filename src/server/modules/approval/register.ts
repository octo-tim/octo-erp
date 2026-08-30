import { registerHrmHandlers } from './handlers/hrm';
import { registerInventoryHandlers } from './handlers/inventory';
import { registerSalesHandlers } from './handlers/sales';
import { registerAccountingHandlers } from './handlers/accounting';

/**
 * Single place where approval target handlers are wired. Imported by the tRPC root so
 * every server entry point registers the same set, and by integration tests.
 * Every business object that DEC-03 can mark as needing approval is registered here.
 */
let registered = false;

export function registerApprovalHandlers(): void {
  if (registered) return;
  registerHrmHandlers();
  registerInventoryHandlers();
  registerSalesHandlers();
  registerAccountingHandlers();
  registered = true;
}

export function __resetRegistration(): void {
  registered = false;
}
