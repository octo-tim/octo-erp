import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';

/** NFR-OPS-05 health check used by Railway and CI. */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const [pending, failed] = await Promise.all([
      prisma.outboxEvent.count({ where: { status: 'PENDING' } }),
      prisma.outboxEvent.count({ where: { status: 'FAILED' } }),
    ]);
    return NextResponse.json({
      status: 'ok',
      db: 'ok',
      outbox: { pending, failed },
      at: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ status: 'error', message: (e as Error).message }, { status: 503 });
  }
}
