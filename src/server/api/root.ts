import { router } from './trpc';
import { authRouter } from './routers/auth';
import { adminRouter } from './routers/admin';
import { notificationRouter } from './routers/notification';
import { attachmentRouter } from './routers/attachment';
import { preferenceRouter } from './routers/preference';
import { hrmRouter } from './routers/hrm';

export const appRouter = router({
  auth: authRouter,
  admin: adminRouter,
  notification: notificationRouter,
  attachment: attachmentRouter,
  preference: preferenceRouter,
  hrm: hrmRouter,
});

export type AppRouter = typeof appRouter;
