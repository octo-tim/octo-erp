'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Select, Spinner } from '@/components/ui/primitives';
import { MIGRATION_TARGETS, TARGET_LABEL } from '@/server/modules/migration/templates';

/**
 * MIG-01..09 — the cut-over screen.
 *
 * It is deliberately a sequence rather than one button. A migration writes the opening
 * position of the books, and the figures have to be read and agreed by a person before
 * anything is written: upload, see the errors, see what the totals will be, then apply.
 * The reconciliation at the end is what the cut-over gets signed off against.
 */
type Row = Record<string, string>;

const STEP_LABEL = ['1. 파일 선택', '2. 검증 결과', '3. 반영과 대사'] as const;

export default function MigrationPage() {
  const [target, setTarget] = useState<(typeof MIGRATION_TARGETS)[number]>('ITEM');
  const [baselineDate, setBaselineDate] = useState('');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconcileBatchId, setReconcileBatchId] = useState<string | null>(null);

  const utils = api.useUtils();
  const templateQuery = api.migration.template.useQuery({ target });
  const batches = api.migration.batches.useQuery({ target, take: 10 });
  const validate = api.migration.validate.useMutation();
  const apply = api.migration.applyBatch.useMutation();
  const reconcileQuery = api.migration.reconcile.useQuery(
    { batchId: reconcileBatchId ?? '' },
    { enabled: reconcileBatchId !== null },
  );

  const validated = validate.data;
  const applied = apply.data;
  const step = applied ? 2 : validated ? 1 : 0;

  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null);
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
      await utils.migration.batches.invalidate();
    } catch (err) {
      setError((err as { message?: string }).message ?? '처리에 실패했습니다.');
    }
  }

  /** Reads the file in the browser: the server is given rows, never a file. */
  async function onFile(file: File) {
    const text = await file.text();
    const lines = text
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      setError('머리글과 데이터가 모두 있는 CSV 파일을 올려주세요.');
      return;
    }
    const headers = splitCsv(lines[0]!);
    const parsed = lines.slice(1).map((line) => {
      const cells = splitCsv(line);
      return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])) as Row;
    });
    setFileName(file.name);
    setRows(parsed);
    validate.reset();
    apply.reset();
    setMessage(`${parsed.length}행을 읽었습니다. 검증을 실행하세요.`);
  }

  function downloadTemplate() {
    const columns = templateQuery.data?.columns ?? [];
    const csv =
      '﻿' +
      columns.map((c) => c.key).join(',') +
      '\r\n' +
      columns.map((c) => (c.required ? `${c.label}(필수)` : c.label)).join(',');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `migration_${target}_v${templateQuery.data?.templateVersion ?? 1}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">데이터 이관</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {STEP_LABEL.map((l, i) => (
            <span key={l} className={i === step ? 'font-semibold text-slate-900' : ''}>
              {i > 0 ? ' · ' : ''}
              {l}
            </span>
          ))}
        </p>
      </header>

      {message ? (
        <p role="status" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="whitespace-pre-line rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <Card title="이관 대상">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="대상" htmlFor="mig-target">
            <Select
              id="mig-target"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value as (typeof MIGRATION_TARGETS)[number]);
                setRows([]);
                validate.reset();
                apply.reset();
              }}
            >
              {MIGRATION_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {TARGET_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="기준일" htmlFor="mig-baseline">
            <Input
              id="mig-baseline"
              type="date"
              value={baselineDate}
              onChange={(e) => setBaselineDate(e.target.value)}
            />
          </Field>
          <Field label="원천 파일" htmlFor="mig-file">
            <Input
              id="mig-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
              }}
            />
          </Field>
        </div>

        {templateQuery.data?.accumulates ? (
          <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            이 대상은 같은 행을 두 번 반영하면 수량·금액이 중복됩니다. 이미 반영된 행은 자동으로 건너뛰지만,
            원천 파일의 기준일과 범위를 먼저 확인하세요.
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button size="sm" onClick={downloadTemplate}>
            양식 내려받기
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={rows.length === 0 || validate.isPending}
            onClick={() =>
              run(
                () =>
                  validate.mutateAsync({
                    target,
                    rows,
                    fileName,
                    ...(baselineDate ? { baselineDate } : {}),
                    requestId: newRequestId(),
                  }),
                '검증을 마쳤습니다. 아래 결과를 확인하세요.',
              )
            }
          >
            {validate.isPending ? '검증 중' : '검증'}
          </Button>
        </div>
      </Card>

      {validated ? (
        <Card title="검증 결과">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <Stat label="원천" value={validated.total} />
            <Stat label="정상" value={validated.valid} />
            <Stat label="오류" value={validated.errorCount} alert={validated.errorCount > 0} />
            <Stat label="이미 반영" value={validated.alreadyApplied} />
            <Stat label="반영 예정" value={validated.valid - validated.alreadyApplied} />
          </dl>

          {validated.preview.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-sm font-semibold">반영 전 합계</h3>
              <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                {validated.preview.map((p) => (
                  <div key={p.label}>
                    <dt className="text-slate-500">{p.label}</dt>
                    <dd className="tabular font-medium">{p.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {validated.errorCount > 0 ? (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-red-700">오류 {validated.errorCount}건</h3>
              <ul className="mt-2 max-h-64 overflow-y-auto text-sm">
                {validated.errors.map((e, i) => (
                  <li key={i} className="border-b border-slate-100 py-1">
                    <strong>{e.row}행</strong>
                    {e.field ? ` · ${e.field}` : ''} — {e.message}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-slate-500">
                민감 항목의 오류는 값을 표시하지 않습니다. 원본 파일에서 확인하세요.
              </p>
            </div>
          ) : null}

          <div className="mt-4">
            <Button
              size="sm"
              variant="primary"
              disabled={validated.valid === 0 || apply.isPending || !!applied}
              onClick={() =>
                run(
                  () =>
                    apply.mutateAsync({
                      batchId: validated.batchId,
                      rows,
                      requestId: newRequestId(),
                    }),
                  '반영을 마쳤습니다. 대사 결과를 확인하세요.',
                )
              }
            >
              {apply.isPending ? '반영 중' : '정상 행 반영'}
            </Button>
            <p className="mt-2 text-xs text-slate-500">
              한 행이라도 실패하면 전체가 취소됩니다. 부분 반영은 되지 않습니다.
            </p>
          </div>
        </Card>
      ) : null}

      {applied ? (
        <Card title="대사 결과">
          <p className="text-sm text-slate-600">
            반영 <strong className="tabular">{applied.applied}</strong>건 · 건너뜀{' '}
            <strong className="tabular">{applied.skipped}</strong>건
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">항목</th>
                  <th className="px-2 py-1.5 text-right font-medium">원천</th>
                  <th className="px-2 py-1.5 text-right font-medium">반영</th>
                  <th className="px-2 py-1.5 text-right font-medium">차이</th>
                </tr>
              </thead>
              <tbody>
                {applied.reconciliation.map((r) => (
                  <tr key={r.label} className="border-b border-slate-100">
                    <td className="px-2 py-1.5">{r.label}</td>
                    <td className="tabular px-2 py-1.5 text-right">{r.source}</td>
                    <td className="tabular px-2 py-1.5 text-right">{r.applied}</td>
                    <td
                      className={`tabular px-2 py-1.5 text-right ${
                        r.difference === '0' ? 'text-slate-500' : 'font-semibold text-red-700'
                      }`}
                    >
                      {r.difference}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {applied.reconciliation.some((r) => r.difference !== '0') ? (
            <p className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              차이가 있습니다. 원천 파일과 대조해 원인을 확인하기 전에는 이관을 완료로 보지 마세요.
            </p>
          ) : (
            <p className="mt-3 rounded bg-green-50 px-3 py-2 text-sm text-green-800">
              모든 항목의 차이가 0입니다.
            </p>
          )}
        </Card>
      ) : null}

      <Card title="최근 이관 이력">
        {batches.isLoading ? (
          <Spinner />
        ) : (batches.data ?? []).length === 0 ? (
          <EmptyState
            title="이관 이력이 없습니다."
            description="양식을 내려받아 원천 파일을 작성한 뒤 검증부터 시작하세요."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">일시</th>
                  <th className="px-2 py-1.5 font-medium">파일</th>
                  <th className="px-2 py-1.5 text-right font-medium">원천</th>
                  <th className="px-2 py-1.5 text-right font-medium">정상</th>
                  <th className="px-2 py-1.5 text-right font-medium">오류</th>
                  <th className="px-2 py-1.5 text-right font-medium">반영</th>
                  <th className="px-2 py-1.5 font-medium">상태</th>
                  <th className="px-2 py-1.5 font-medium">작업</th>
                </tr>
              </thead>
              <tbody>
                {(batches.data ?? []).map((b) => (
                  <tr key={b.id} className="border-b border-slate-100">
                    <td className="px-2 py-1.5">
                      {new Date(b.createdAt as unknown as string)
                        .toISOString()
                        .slice(0, 16)
                        .replace('T', ' ')}
                    </td>
                    <td className="px-2 py-1.5">{b.fileName ?? '-'}</td>
                    <td className="tabular px-2 py-1.5 text-right">{b.totalRows}</td>
                    <td className="tabular px-2 py-1.5 text-right">{b.validRows}</td>
                    <td className="tabular px-2 py-1.5 text-right">{b.errorRows}</td>
                    <td className="tabular px-2 py-1.5 text-right">{b.appliedRows}</td>
                    <td className="px-2 py-1.5">{b.status}</td>
                    <td className="px-2 py-1.5">
                      {b.status === 'APPLIED' ? (
                        <Button size="sm" onClick={() => setReconcileBatchId(b.id)}>
                          대사
                        </Button>
                      ) : (
                        <span className="text-xs text-slate-400">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {reconcileBatchId ? (
        <Card
          title="이관 대사 (MIG-09)"
          actions={
            <Button size="sm" onClick={() => setReconcileBatchId(null)}>
              닫기
            </Button>
          }
        >
          {reconcileQuery.isLoading ? (
            <Spinner />
          ) : reconcileQuery.error ? (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              {reconcileQuery.error.message}
            </p>
          ) : reconcileQuery.data ? (
            <>
              <p className="text-sm text-slate-600">
                {reconcileQuery.data.targetLabel} · {reconcileQuery.data.fileName ?? '파일명 없음'}
                {reconcileQuery.data.baselineDate ? ` · 기준일 ${reconcileQuery.data.baselineDate}` : ''}
              </p>

              <h3 className="mt-4 text-sm font-semibold">원천 대비 건수</h3>
              <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                <Stat label="원천" value={reconcileQuery.data.counts.source} />
                <Stat label="정상" value={reconcileQuery.data.counts.valid} />
                <Stat
                  label="오류"
                  value={reconcileQuery.data.counts.error}
                  alert={reconcileQuery.data.counts.error > 0}
                />
                <Stat label="반영" value={reconcileQuery.data.counts.applied} />
                <Stat label="건너뜀" value={reconcileQuery.data.counts.skipped} />
              </dl>
              <p
                className={`mt-3 rounded px-3 py-2 text-sm ${
                  reconcileQuery.data.countsBalance ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'
                }`}
                role={reconcileQuery.data.countsBalance ? 'status' : 'alert'}
              >
                {reconcileQuery.data.countsBalance
                  ? '원천 건수와 정상·오류 건수의 합이 일치합니다.'
                  : '원천 건수와 정상·오류 건수의 합이 일치하지 않습니다. 이관이 정상적으로 끝나지 않았을 수 있습니다.'}
              </p>

              <h3 className="mt-4 text-sm font-semibold">대상별 반영 합계 (원천 대비)</h3>
              <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                {reconcileQuery.data.summary.map((s) => (
                  <div key={s.label}>
                    <dt className="text-slate-500">{s.label}</dt>
                    <dd className="tabular font-medium">{s.value}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

function Stat({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className={`tabular text-lg font-semibold ${alert ? 'text-red-700' : ''}`}>{value}</dd>
    </div>
  );
}

/** A CSV line, respecting quoted cells that contain commas. */
function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}
