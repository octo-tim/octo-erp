import { router } from './trpc';
import { authRouter } from './routers/auth';
import { adminRouter } from './routers/admin';
import { notificationRouter } from './routers/notification';
import { attachmentRouter } from './routers/attachment';
import { preferenceRouter } from './routers/preference';
import { hrmRouter } from './routers/hrm';
import { approvalRouter } from './routers/approval';
import { masterRouter } from './routers/master';
import { inventoryRouter } from './routers/inventory';
import { accountingRouter } from './routers/accounting';
import { salesRouter } from './routers/sales';
import { reportRouter } from './routers/report';
import { migrationRouter } from './routers/migration';
import { registerApprovalHandlers } from '@/server/modules/approval/register';

// APV-08/09: handlers must be registered before any request can approve a document.
registerApprovalHandlers();

export const appRouter = router({
  auth: authRouter,
  admin: adminRouter,
  notification: notificationRouter,
  attachment: attachmentRouter,
  preference: preferenceRouter,
  hrm: hrmRouter,
  approval: approvalRouter,
  master: masterRouter,
  inventory: inventoryRouter,
  accounting: accountingRouter,
  sales: salesRouter,
  report: reportRouter,
  migration: migrationRouter,
});

export type AppRouter = typeof appRouter;
