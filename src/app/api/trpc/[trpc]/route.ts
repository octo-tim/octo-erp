import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/api/root';
import { createContext } from '@/server/api/trpc';
import { logger } from '@/server/core/logger';

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createContext(req),
    onError: ({ error, path }) => {
      logger.error({ path, code: error.code, err: error.message }, 'trpc error');
    },
  });

export { handler as GET, handler as POST };
