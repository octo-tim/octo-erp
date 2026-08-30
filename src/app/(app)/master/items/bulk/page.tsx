'use client';

import { useMemo, useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Select, Spinner, StatusBadge } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';

/**
 * BAS-03: download the template, upload a file, see every row's errors, then apply only
 * the rows you choose. Nothing is written until "선택 행 반영".
 */
type Target = 'ITEM' | 'PARTNER';

interface RowError {
  row: number;
  field?: string;
  message: string;
}

export default function BulkImportPage() {
  const [target, setTarget] = useState<Target>('ITEM');
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const template = api.master.importTemplate.useQuery({ targetType: target });
  const batches = api.master.importBatches.useQuery({ targetType: target });
  const validate = api.master.validateImport.useMutation();
  const apply = api.master.applyImport.useMutation();

  const result = validate.data;
  const errorsByRow = useMemo(() => {
    const map = new Map<number, RowError[]>();
    for (const e of (result?.errors ?? []) as RowError[]) {
      map.set(e.row, [...(map.get(e.row) ?? []), e]);
    }
    return map;
  }, [result]);

  function downloadTemplate() {
    if (!template.data) return;
    const header = template.data.columns.map((c) => c.label).join(',');
    const keys = template.data.columns.map((c) => c.key).join(',');
    const csv = `﻿${header}\n${keys}\n`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${target === 'ITEM' ? '품목' : '거래처'}_일괄등록_양식_v${template.data.version}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !template.data) return;
    setParseError(null);
    setMessage(null);
    setSelected([]);

    const text = await file.text();
    const lines = text
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .filter((l) => l.trim());
    if (lines.length < 2) {
      setParseError('데이터 행이 없습니다. 양식의 2행(키 행) 아래에 데이터를 입력하세요.');
      return;
    }

    // Row 1 is the human label row, row 2 the key row, data from row 3 (the CSV template shape).
    const keyRow = lines[1]!.split(',').map((s) => s.trim());
    const known = new Set<string>(template.data.columns.map((c) => c.key as string));
    if (!keyRow.some((k) => known.has(k))) {
      setParseError('양식의 키 행을 찾을 수 없습니다. 최신 양식을 내려받아 사용하세요.');
      return;
    }

    const parsed = lines.slice(2).map((line) => {
      const cells = line.split(',');
      const row: Record<string, string> = {};
      keyRow.forEach((key, i) => {
        if (known.has(key)) row[key] = (cells[i] ?? '').trim();
      });
      return row;
    });

    setRows(parsed);
    setFileName(file.name);
    const validated = await validate.mutateAsync({
      targetType: target,
      rows: parsed,
      fileName: file.name,
      requestId: newRequestId(),
    });
    setSelected(validated.validRows);
    e.target.value = '';
  }

  async function applySelected() {
    if (!result) return;
    setMessage(null);
    try {
      const applied = await apply.mutateAsync({
        batchId: result.batchId,
        targetType: target,
        rows,
        selectedRows: selected,
        requestId: newRequestId(),
      });
      setMessage(`${applied.applied}건 반영했습니다 (신규 ${applied.created}건, 수정 ${applied.updated}건).`);
      await batches.refetch();
    } catch (err) {
      setMessage((err as { message?: string }).message ?? '반영에 실패했습니다.');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">일괄등록</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          양식을 내려받아 작성한 뒤 올리면 행별로 검증합니다. 선택한 정상 행만 반영되며, 한 건이라도 실패하면
          전체가 취소됩니다.
        </p>
      </header>

      <Card title="1. 양식 준비">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="대상" htmlFor="bulk-target" className="w-48">
            <Select
              id="bulk-target"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value as Target);
                setRows([]);
                setSelected([]);
                validate.reset();
              }}
            >
              <option value="ITEM">품목</option>
              <option value="PARTNER">거래처</option>
            </Select>
          </Field>
          <Button size="sm" onClick={downloadTemplate} disabled={!template.data}>
            양식 다운로드 (v{template.data?.version ?? '-'})
          </Button>
          <label className="inline-flex">
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={onFile} />
            <span className="inline-flex h-9 cursor-pointer items-center rounded-md border border-blue-600 bg-blue-600 px-3 text-sm font-medium text-white">
              파일 올리기
            </span>
          </label>
          {fileName ? <span className="text-sm text-slate-500">{fileName}</span> : null}
        </div>

        {template.data ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium">
              양식 항목 ({template.data.columns.length}개)
            </summary>
            <ul className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {template.data.columns.map((c) => (
                <li key={c.key}>
                  <span className="font-medium">{c.label}</span>
                  {c.required ? <span className="ml-1 text-red-600">필수</span> : null}
                  {'note' in c && c.note ? <span className="ml-1 text-slate-500">— {c.note}</span> : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {parseError ? (
          <p role="alert" className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {parseError}
          </p>
        ) : null}
      </Card>

      {validate.isPending ? <Spinner label="검증 중" /> : null}

      {result ? (
        <Card
          title={`2. 검증 결과 — 전체 ${fmt.count(result.total)}행 / 정상 ${fmt.count(result.valid)}행 / 오류 ${fmt.count(result.total - result.valid)}행`}
          actions={
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => setSelected(result.validRows)}>
                정상행 전체선택
              </Button>
              <Button size="sm" onClick={() => setSelected([])}>
                선택해제
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={selected.length === 0 || apply.isPending}
                onClick={applySelected}
              >
                선택 {selected.length}행 반영
              </Button>
            </div>
          }
        >
          {message ? (
            <p role="status" className="mb-3 rounded bg-green-50 px-3 py-2 text-sm text-green-800">
              {message}
            </p>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="w-12 px-2 py-2">
                    <span className="sr-only">선택</span>
                  </th>
                  <th scope="col" className="w-16 px-3 py-2 text-left font-semibold">
                    행
                  </th>
                  <th scope="col" className="w-24 px-3 py-2 text-left font-semibold">
                    처리
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    내용
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    오류
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((_, i) => {
                  const rowNo = i + 1;
                  const rowErrors = errorsByRow.get(rowNo) ?? [];
                  const ok = rowErrors.length === 0;
                  const preview = result.preview.find((p) => p.row === rowNo);
                  return (
                    <tr key={rowNo} className={ok ? '' : 'bg-red-50/60'}>
                      <td className="px-2 py-1.5">
                        <input
                          type="checkbox"
                          aria-label={`${rowNo}행 선택`}
                          disabled={!ok}
                          checked={selected.includes(rowNo)}
                          onChange={() =>
                            setSelected((prev) =>
                              prev.includes(rowNo) ? prev.filter((r) => r !== rowNo) : [...prev, rowNo],
                            )
                          }
                        />
                      </td>
                      <td className="px-3 py-1.5 tabular">{rowNo}</td>
                      <td className="px-3 py-1.5">
                        {ok ? (
                          <StatusBadge
                            status={preview?.action === 'UPDATE' ? 'IN_PROGRESS' : 'CONFIRMED'}
                            label={preview?.action === 'UPDATE' ? '수정' : '신규'}
                          />
                        ) : (
                          <StatusBadge status="CANCELED" label="오류" />
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        {preview?.summary ??
                          Object.values(rows[i] ?? {})
                            .filter(Boolean)
                            .join(' / ')}
                      </td>
                      <td className="px-3 py-1.5 text-red-700">
                        {rowErrors.map((e) => (
                          <div key={`${e.field}-${e.message}`}>
                            {e.field ? `${e.field}: ` : ''}
                            {e.message}
                          </div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <Card title="업로드 이력">
        {(batches.data ?? []).length === 0 ? (
          <EmptyState title="업로드 이력이 없습니다." />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {(batches.data ?? []).map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="text-slate-500">{fmt.dateTime(b.createdAt as unknown as string)}</span>
                <span>{b.fileName ?? '(파일명 없음)'}</span>
                <span className="tabular text-slate-600">
                  전체 {b.totalRows} / 정상 {b.validRows} / 오류 {b.errorRows} / 반영 {b.appliedRows}
                </span>
                <StatusBadge
                  status={b.status === 'APPLIED' ? 'CONFIRMED' : 'DRAFT'}
                  label={b.status === 'APPLIED' ? '반영완료' : '검증만'}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
