import type { Actor, TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { has } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import { assertUploadAllowed, buildStorageKey, getStorage, sha256 } from './service';

/** UIX-07: owner types and the permission required to read/write their attachments. */
export const OWNER_PERMISSIONS: Record<string, { read: string[]; write: string[] }> = {
  ITEM: { read: ['master.read'], write: ['master.write'] },
  PARTNER: { read: ['master.read'], write: ['master.write'] },
  SALES_DOC: { read: ['sales.read'], write: ['sales.write'] },
  PURCHASE_DOC: { read: ['purchase.read', 'sales.read'], write: ['purchase.write', 'sales.write'] },
  STOCK_DOC: { read: ['inventory.read'], write: ['inventory.write'] },
  JOURNAL: { read: ['accounting.read'], write: ['accounting.write'] },
  APPROVAL_DOC: { read: ['approval.use'], write: ['approval.use'] },
  // hr.self alone is not enough: it only grants access when ownerId is the actor's own
  // employee record, which SELF_OWNED_TYPES handles below (NFR-SEC-02).
  EMPLOYEE_DOC: { read: ['hr.read'], write: ['hr.write'] },
  MIGRATION: { read: ['admin.migration'], write: ['admin.migration'] },
};

/** Owner types whose ownerId is an employeeId, so the subject may read their own files. */
const SELF_OWNED_TYPES: Record<string, string> = { EMPLOYEE_DOC: 'hr.self' };

function assertOwnerPermission(
  ctx: { actor: Actor },
  ownerType: string,
  mode: 'read' | 'write',
  ownerId?: string,
): void {
  const rule = OWNER_PERMISSIONS[ownerType];
  if (!rule) throw new AppError('VALIDATION', `알 수 없는 첨부 소유 유형입니다: ${ownerType}`);
  if (ctx.actor.isAdmin) return;
  if (rule[mode].some((p) => has(ctx.actor, p))) return;

  const selfPermission = SELF_OWNED_TYPES[ownerType];
  if (
    mode === 'read' &&
    selfPermission &&
    ownerId &&
    ctx.actor.employeeId === ownerId &&
    has(ctx.actor, selfPermission)
  ) {
    return;
  }
  throw new AppError('FORBIDDEN', '이 첨부파일에 접근할 권한이 없습니다.', { ownerType, mode });
}

export interface UploadInput {
  ownerType: string;
  ownerId: string;
  originalName: string;
  mimeType: string;
  body: Buffer;
  accessScope?: string;
}

export interface StagedUpload {
  storageKey: string;
  size: number;
  sha256: string;
}

/**
 * Writes the bytes, before any transaction is open.
 *
 * The upload used to happen inside the business transaction, which is wrong in both
 * directions: a 20MB round trip to object storage held a database connection open against
 * a 20 second transaction timeout, and a rollback left a file with no row and nothing to
 * clean it up — the cleanup job the old comment pointed at was never written. Permission
 * and file validation still happen first, so nothing unauthorised is ever written.
 */
export async function stageUpload(
  ctx: { actor: Actor; now: Date },
  input: Omit<UploadInput, 'accessScope'>,
): Promise<StagedUpload> {
  assertOwnerPermission(ctx, input.ownerType, 'write', input.ownerId);
  assertUploadAllowed({
    size: input.body.length,
    mimeType: input.mimeType,
    originalName: input.originalName,
    head: input.body.subarray(0, 8),
  });

  const storageKey = buildStorageKey(input.ownerType, input.mimeType, ctx.now);
  await getStorage().put(storageKey, input.body, input.mimeType);
  return { storageKey, size: input.body.length, sha256: sha256(input.body) };
}

/** Removes a staged object whose transaction did not commit. Best effort by nature. */
export async function discardStaged(staged: StagedUpload): Promise<void> {
  await getStorage()
    .remove(staged.storageKey)
    .catch(() => {
      /* the row was never created, so the worst case is an unreferenced file */
    });
}

/**
 * Records an already-staged upload. Runs inside the caller's transaction, so the row lands
 * with everything else the request wrote or with none of it.
 */
export async function upload(ctx: TransactionContext, input: UploadInput, staged: StagedUpload) {
  assertOwnerPermission(ctx, input.ownerType, 'write', input.ownerId);
  const storageKey = staged.storageKey;

  const attachment = await ctx.tx.attachment.create({
    data: {
      storageKey,
      originalName: input.originalName.slice(0, 255),
      mimeType: input.mimeType,
      size: staged.size,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      accessScope: input.accessScope ?? 'OWNER',
      uploadedById: ctx.actor.userId === 'system' ? null : ctx.actor.userId,
      sha256: staged.sha256,
    },
  });

  await audit.record(ctx, {
    action: 'attachment.upload',
    entityType: 'Attachment',
    entityId: attachment.id,
    after: { originalName: attachment.originalName, ownerType: input.ownerType, ownerId: input.ownerId, size: attachment.size },
  });

  return attachment;
}

export async function list(ctx: TransactionContext, ownerType: string, ownerId: string) {
  assertOwnerPermission(ctx, ownerType, 'read', ownerId);
  return ctx.tx.attachment.findMany({
    where: { ownerType, ownerId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, originalName: true, mimeType: true, size: true, createdAt: true, uploadedById: true },
  });
}

/** Returns a short-lived signed URL; permission is re-checked against the owning entity. */
export async function downloadUrl(ctx: TransactionContext, attachmentId: string, expiresInSeconds = 300) {
  const att = await ctx.tx.attachment.findUnique({ where: { id: attachmentId } });
  if (!att || att.deletedAt) throw new AppError('NOT_FOUND', '첨부파일을 찾을 수 없습니다.');
  assertOwnerPermission(ctx, att.ownerType, 'read', att.ownerId);

  await audit.record(ctx, {
    action: 'attachment.download',
    entityType: 'Attachment',
    entityId: att.id,
    meta: { ownerType: att.ownerType, ownerId: att.ownerId },
  });

  return {
    // the link is issued to this user and to nobody else (NFR-SEC-07)
    url: await getStorage().signedUrl(att.storageKey, expiresInSeconds, ctx.actor.userId),
    originalName: att.originalName,
    mimeType: att.mimeType,
  };
}

export async function softDelete(ctx: TransactionContext, attachmentId: string) {
  const att = await ctx.tx.attachment.findUnique({ where: { id: attachmentId } });
  if (!att || att.deletedAt) throw new AppError('NOT_FOUND', '첨부파일을 찾을 수 없습니다.');
  assertOwnerPermission(ctx, att.ownerType, 'write', att.ownerId);
  await ctx.tx.attachment.update({ where: { id: attachmentId }, data: { deletedAt: ctx.now } });
  await audit.record(ctx, {
    action: 'attachment.delete',
    entityType: 'Attachment',
    entityId: att.id,
    before: { originalName: att.originalName },
  });
}
