import { registerHrmHandlers } from './handlers/hrm';
import { registerInventoryHandlers } from './handlers/inventory';

/**
 * Single place where approval target handlers are wired. Imported by the tRPC root so
 * every server entry point registers the same set, and by integration tests.
 * Later steps add sales/purchase/inventory/journal handlers here.
 */
let registered = false;

export function registerApprovalHandlers(): void {
  if (registered) return;
  registerHrmHandlers();
  registerInventoryHandlers();
  registered = true;
}

export function __resetRegistration(): void {
  registered = false;
}
