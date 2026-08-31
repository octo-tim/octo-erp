import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import { add, amount, D, quantity } from '@/lib/money';
import {
  ACCUMULATES,
  MIGRATION_TARGETS,
  TARGET_LABEL,
  TEMPLATES,
  TEMPLATE_VERSION,
  sensitiveKeys,
  type MigrationTarget,
} from './templates';
import { HANDLERS } from './targets';

/**
 * MIG-01..09 — the migration pipeline.
 *
 * The shape is the same for every target: analyse the file, validate every row, show what
 * would happen, apply only what was approved, then reconcile. What makes it a migration
 * rather than a bulk upload is what happens on the second run. A migration writes the
 * opening position of the books, so applying a source row twice would double a stock
 * quantity or a balance and nothing on screen would say so. Every applied row is therefore
 * recorded by its business key, and a row that has been applied before is skipped and
 * reported as skipped rather than silently repeated or loudly failed — re-running a file
 * after fixing three rows in it is a normal thing to need to do.
 */

export interface RowError {
  row: number;
  field?: string;
  message: string;
}

export interface ValidationResult {
  batchId: string;
  target: MigrationTarget;
  targetLabel: string;
  total: number;
  valid: number;
  errorCount: number;
  alreadyApplied: number;
  errors: RowError[];
  /** MIG-04: totals before anything is written, so the figures can be agreed first */
  preview: { label: string; value: string }[];
}

const MAX_ROWS = 20_000;

function assertTarget(target: string): asserts target is MigrationTarget {
  if (!(MIGRATION_TARGETS as readonly string[]).includes(target)) {
    throw new AppError('VALIDATION', `알 수 없는 이관 대상입니다: ${target}`);
  }
}

/**
 * NFR-SEC-05 / MIG-09: an error report names the row and the column, never the value in a
 * sensitive column. A resident registration number that reaches an error file has left the
 * system, and error files get emailed around.
 */
function redact(target: MigrationTarget, errors: RowError[]): RowError[] {
  const sensitive = sensitiveKeys(target);
  return errors.map((e) =>
    e.field && sensitive.has(e.field)
      ? { ...e, message: `${e.field} 값이 올바르지 않습니다. 원본 파일에서 확인하세요.` }
      : e,
  );
}

export async function template(ctx: TransactionContext, target: string) {
  requirePermission(ctx.actor, 'admin.migration');
  assertTarget(target);
  return {
    target,
    label: TARGET_LABEL[target],
    templateVersion: TEMPLATE_VERSION,
    accumulates: ACCUMULATES[target],
    columns: TEMPLATES[target],
  };
}

/**
 * Steps 1 to 4: analyse, validate every row, and produce the pre-apply figures. Nothing is
 * written to the business tables here — only the batch record and its error list.
 */
export async function validate(
  ctx: TransactionContext,
  input: {
    target: string;
    rows: Record<string, string>[];
    fileName?: string;
    baselineDate?: string;
    templateVersion?: number;
    note?: string;
  },
): Promise<ValidationResult> {
  requirePermission(ctx.actor, 'admin.migration');
  assertTarget(input.target);
  const target = input.target;

  if ((input.templateVersion ?? TEMPLATE_VERSION) !== TEMPLATE_VERSION) {
    throw new AppError(
      'VALIDATION',
      `양식 버전이 다릅니다. 최신 양식(v${TEMPLATE_VERSION})을 내려받아 다시 작성하세요.`,
      { expected: TEMPLATE_VERSION, received: input.templateVersion },
    );
  }
  if (input.rows.length === 0) throw new AppError('VALIDATION', '이관할 행이 없습니다.');
  if (input.rows.length > MAX_ROWS) {
    throw new AppError('VALIDATION', `한 번에 ${MAX_ROWS.toLocaleString()}행까지 처리할 수 있습니다.`);
  }

  const handler = HANDLERS[target];
  const rowCtx = await handler.prepare(ctx);

  const errors: RowError[] = [];
  const keys = new Map<string, number>();
  const valid: { rowNo: number; sourceKey: string }[] = [];

  for (const [i, row] of input.rows.entries()) {
    const rowNo = i + 1;
    const rowErrors = await handler.validateRow(rowCtx, row, rowNo);
    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    // a file that repeats a key inside itself is a source problem, and applying both rows
    // would double exactly what this pipeline exists to protect
    const sourceKey = handler.sourceKey(row);
    const seen = keys.get(sourceKey);
    if (seen !== undefined) {
      errors.push({ row: rowNo, message: `${seen}행과 같은 키가 중복되었습니다: ${sourceKey}` });
      continue;
    }
    keys.set(sourceKey, rowNo);
    valid.push({ rowNo, sourceKey });
  }

  // MIG: rows applied by an earlier batch are reported up front, not discovered at apply
  const applied = await ctx.tx.migrationRow.findMany({
    where: { targetType: target, sourceKey: { in: valid.map((v) => v.sourceKey) } },
    select: { sourceKey: true },
  });
  const appliedKeys = new Set(applied.map((a) => a.sourceKey));

  const previewRows = valid.filter((v) => !appliedKeys.has(v.sourceKey));
  const preview = await handler.preview(
    rowCtx,
    previewRows.map((v) => input.rows[v.rowNo - 1]!),
  );

  const redacted = redact(target, errors);
  const batch = await ctx.tx.migrationBatch.create({
    data: {
      targetType: target,
      templateVersion: TEMPLATE_VERSION,
      fileName: input.fileName ?? null,
      baselineDate: input.baselineDate ? new Date(`${input.baselineDate}T00:00:00.000Z`) : null,
      totalRows: input.rows.length,
      validRows: valid.length,
      errorRows: errors.length,
      errors: redacted as never,
      note: input.note ?? null,
      createdById: ctx.actor.userId,
    },
  });

  await audit.record(ctx, {
    action: 'migration.validate',
    entityType: 'MigrationBatch',
    entityId: batch.id,
    after: {
      target,
      total: input.rows.length,
      valid: valid.length,
      errors: errors.length,
      alreadyApplied: appliedKeys.size,
    },
  });

  return {
    batchId: batch.id,
    target,
    targetLabel: TARGET_LABEL[target],
    total: input.rows.length,
    valid: valid.length,
    errorCount: errors.length,
    alreadyApplied: appliedKeys.size,
    errors: redacted,
    preview,
  };
}

export interface ApplyResult {
  batchId: string;
  applied: number;
  skipped: number;
  reconciliation: { label: string; source: string; applied: string; difference: string }[];
}

/**
 * Steps 5 and 6: apply the approved rows and reconcile.
 *
 * It runs in the caller's transaction, so a failure on row 900 leaves nothing behind from
 * rows 1 to 899. That is the right default for an opening position: a half-migrated
 * balance sheet is worse than none, because it looks like a complete one.
 */
export async function apply(
  ctx: TransactionContext,
  input: { batchId: string; rows: Record<string, string>[]; selectedRows?: number[] },
): Promise<ApplyResult> {
  requirePermission(ctx.actor, 'admin.migration');

  const batch = await ctx.tx.migrationBatch.findUniqueOrThrow({ where: { id: input.batchId } });
  if (batch.status === 'APPLIED') {
    throw new AppError('DUPLICATE_EFFECT', '이미 반영된 이관 배치입니다.', { batchId: batch.id });
  }
  const target = batch.targetType as MigrationTarget;
  assertTarget(target);

  const handler = HANDLERS[target];
  const rowCtx = await handler.prepare(ctx);
  const wanted = input.selectedRows ?? input.rows.map((_, i) => i + 1);

  let applied = 0;
  let skipped = 0;

  for (const rowNo of wanted) {
    const row = input.rows[rowNo - 1];
    if (!row) throw new AppError('VALIDATION', `선택한 행이 파일에 없습니다: ${rowNo}행`);

    const rowErrors = await handler.validateRow(rowCtx, row, rowNo);
    if (rowErrors.length > 0) {
      // re-validated at apply time: the master data may have moved since validation
      throw new AppError('VALIDATION', redact(target, rowErrors)[0]!.message, { row: rowNo });
    }

    const sourceKey = handler.sourceKey(row);
    const already = await ctx.tx.migrationRow.findUnique({
      where: { targetType_sourceKey: { targetType: target, sourceKey } },
    });
    if (already) {
      skipped += 1;
      continue;
    }

    const result = await handler.applyRow(rowCtx, row);
    await ctx.tx.migrationRow.create({
      data: {
        batchId: batch.id,
        targetType: target,
        sourceKey,
        rowNo,
        entityType: result.entityType,
        entityId: result.entityId,
      },
    });
    applied += 1;
  }

  await ctx.tx.migrationBatch.update({
    where: { id: batch.id },
    data: { status: 'APPLIED', appliedRows: applied, skippedRows: skipped, appliedAt: ctx.now },
  });

  const reconciliation = await handler.reconcile(
    rowCtx,
    wanted.map((n) => input.rows[n - 1]!),
  );

  await audit.record(ctx, {
    action: 'migration.apply',
    entityType: 'MigrationBatch',
    entityId: batch.id,
    after: { target, applied, skipped, selected: wanted.length },
  });

  return { batchId: batch.id, applied, skipped, reconciliation };
}

/**
 * MIG-09: the reconciliation the cut-over is signed off against. It compares what the
 * source said with what the system now holds, per target, and every line carries its own
 * difference so a mismatch is a number rather than a judgement.
 */
export async function reconcile(ctx: TransactionContext, batchId: string) {
  requirePermission(ctx.actor, 'admin.migration');
  const batch = await ctx.tx.migrationBatch.findUniqueOrThrow({
    where: { id: batchId },
    include: { rows: { select: { entityType: true, entityId: true, sourceKey: true } } },
  });
  const target = batch.targetType as MigrationTarget;
  assertTarget(target);

  const handler = HANDLERS[target];
  const rowCtx = await handler.prepare(ctx);
  const summary = await handler.summarise(rowCtx, batch.rows);

  return {
    batchId: batch.id,
    target,
    targetLabel: TARGET_LABEL[target],
    fileName: batch.fileName,
    baselineDate: batch.baselineDate?.toISOString().slice(0, 10) ?? null,
    status: batch.status,
    counts: {
      source: batch.totalRows,
      valid: batch.validRows,
      error: batch.errorRows,
      applied: batch.appliedRows,
      skipped: batch.skippedRows,
    },
    // the counts have to add up before any of the amount lines mean anything
    countsBalance: batch.validRows + batch.errorRows === batch.totalRows,
    summary,
  };
}

export async function listBatches(ctx: TransactionContext, target?: string, take = 50) {
  requirePermission(ctx.actor, 'admin.migration');
  if (target) assertTarget(target);
  return ctx.tx.migrationBatch.findMany({
    where: target ? { targetType: target } : {},
    orderBy: { createdAt: 'desc' },
    take,
  });
}

export { amount, add, D, quantity };
