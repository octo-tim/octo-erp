'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Select, Spinner } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/**
 * ACC-03: the account slots the rules resolve through, plus each rule's versions and a
 * preview of what the current version would post. The preview is the point of the screen —
 * a rule is only trustworthy if you can see the entry it produces before it produces one.
 */
const SAMPLE_AMOUNTS: Record<string, string> = {
  supply: '1000000',
  vat: '100000',
  total: '1100000',
  cost: '700000',
  adjustment: '50000',
};

interface TemplateLine {
  slot: string;
  side: 'DEBIT' | 'CREDIT';
  amountKey: string;
  description?: string;
}

const emptyTemplateLine = (): TemplateLine => ({ slot: '', side: 'DEBIT', amountKey: '', description: '' });

export default function PostingRulesPage() {
  const utils = api.useUtils();
  const refresh = { onSuccess: () => utils.accounting.invalidate() };

  const [selected, setSelected] = useState('SALES');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ACC-03: publishing a new posting-rule version, kept separate from the preview form above
  const [publishing, setPublishing] = useState(false);
  const [templateLines, setTemplateLines] = useState<TemplateLine[]>([]);
  const [effectiveFrom, setEffectiveFrom] = useState(businessDate(new Date()));
  const [ruleNote, setRuleNote] = useState('');

  const mappings = api.accounting.accountMappings.useQuery();
  const accounts = api.accounting.postableAccounts.useQuery();
  const rules = api.accounting.postingRules.useQuery();
  const setMapping = api.accounting.setAccountMapping.useMutation(refresh);
  const publish = api.accounting.publishPostingRule.useMutation(refresh);
  const preview = api.accounting.previewPostingRule.useQuery({
    code: selected,
    onDate: businessDate(new Date()),
    amounts: SAMPLE_AMOUNTS,
  });

  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null);
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
    } catch (err) {
      setError((err as { message?: string }).message ?? '처리에 실패했습니다.');
    }
  }

  function startPublish() {
    const rule = (rules.data ?? []).find((r) => r.code === selected);
    const latest = rule?.versions[0];
    setTemplateLines(
      latest
        ? (latest.template as unknown as TemplateLine[]).map((l) => ({ ...l }))
        : [emptyTemplateLine(), emptyTemplateLine()],
    );
    setEffectiveFrom(businessDate(new Date()));
    setRuleNote(rule?.note ?? '');
    setError(null);
    setMessage(null);
    setPublishing(true);
  }

  async function submitPublish() {
    const lines = templateLines.filter((l) => l.slot || l.amountKey || l.description);
    if (lines.length < 2) {
      setError('규칙은 차변·대변을 합쳐 두 줄 이상이어야 합니다.');
      return;
    }
    if (lines.some((l) => !l.slot || !l.amountKey)) {
      setError('모든 행에 계정 역할과 금액 항목을 입력하세요.');
      return;
    }

    await run(
      () =>
        publish.mutateAsync({
          code: selected,
          effectiveFrom,
          template: lines.map((l) => ({
            slot: l.slot,
            side: l.side,
            amountKey: l.amountKey,
            ...(l.description ? { description: l.description } : {}),
          })),
          ...(ruleNote ? { note: ruleNote } : {}),
          requestId: newRequestId(),
        }),
      `${selected} 규칙의 새 버전을 발행했습니다. ${effectiveFrom}부터 적용되며 이미 확정된 분개는 그대로 유지됩니다.`,
    );
    setPublishing(false);
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">분개규칙</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          자동분개는 계정코드를 직접 쓰지 않고 계정 역할을 통해 분개합니다. 규칙은 버전과 적용 시작일을
          가지며, 과거 분개는 소급 변경되지 않습니다.
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

      <Card title="계정 역할 매핑">
        {mappings.isLoading ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="border-b border-slate-200 text-left text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-medium">역할</th>
                  <th className="px-2 py-1.5 font-medium">계정과목</th>
                  <th className="px-2 py-1.5 font-medium">변경</th>
                </tr>
              </thead>
              <tbody>
                {(mappings.data ?? []).map((m) => (
                  <tr key={m.slot} className="border-b border-slate-100">
                    <td className="px-2 py-1.5">{m.label}</td>
                    <td className="px-2 py-1.5">
                      {m.account ? (
                        <>
                          <span className="tabular text-slate-500">{m.account.code}</span> {m.account.name}
                        </>
                      ) : (
                        <span className="text-red-700">미지정</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <Select
                        aria-label={`${m.label} 계정과목`}
                        className="max-w-xs"
                        value={m.account?.id ?? ''}
                        onChange={(e) =>
                          run(
                            () =>
                              setMapping.mutateAsync({
                                slot: m.slot,
                                accountId: e.target.value,
                                requestId: newRequestId(),
                              }),
                            `${m.label} 계정을 변경했습니다.`,
                          )
                        }
                      >
                        <option value="">선택</option>
                        {(accounts.data ?? []).map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} {a.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="규칙 버전">
        {rules.isLoading ? (
          <Spinner />
        ) : (rules.data ?? []).length === 0 ? (
          <EmptyState title="분개규칙이 없습니다." />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {(rules.data ?? []).map((r) => (
              <li key={r.id} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.label}</span>
                  <span className="text-slate-500">{r.code}</span>
                  <span className="text-slate-500">버전 {r.versions.length}개</span>
                </div>
                <ul className="mt-1 pl-4 text-xs text-slate-600">
                  {r.versions.map((v) => (
                    <li key={v.id}>
                      v{v.version} · {fmt.date(v.effectiveFrom as unknown as string)} ~{' '}
                      {v.effectiveTo ? fmt.date(v.effectiveTo as unknown as string) : '현재'}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 border-t border-slate-100 pt-3">
          {!publishing ? (
            <Button size="sm" onClick={startPublish} disabled={(rules.data ?? []).length === 0}>
              새 버전 발행
            </Button>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-slate-500">
                새 버전은 아래 적용 시작일부터만 사용됩니다. 이미 확정된 분개는 다시 만들어지거나 수정되지
                않습니다 — 과거 분개는 그때의 규칙 버전을 그대로 간직합니다.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="대상 규칙" htmlFor="pr-pub-code">
                  <Select id="pr-pub-code" value={selected} onChange={(e) => setSelected(e.target.value)}>
                    {(rules.data ?? []).map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.label} ({r.code})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="적용 시작일" htmlFor="pr-pub-from" required>
                  <Input
                    id="pr-pub-from"
                    type="date"
                    value={effectiveFrom}
                    onChange={(e) => setEffectiveFrom(e.target.value)}
                  />
                </Field>
                <Field label="메모" htmlFor="pr-pub-note">
                  <Input id="pr-pub-note" value={ruleNote} onChange={(e) => setRuleNote(e.target.value)} />
                </Field>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead className="border-b border-slate-200 text-left text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">계정 역할</th>
                      <th className="px-2 py-1.5 font-medium">차/대</th>
                      <th className="px-2 py-1.5 font-medium">금액 항목</th>
                      <th className="px-2 py-1.5 font-medium">적요</th>
                      <th className="px-2 py-1.5 font-medium">삭제</th>
                    </tr>
                  </thead>
                  <tbody>
                    {templateLines.map((line, i) => (
                      <tr key={i} className="border-b border-slate-100">
                        <td className="px-2 py-1">
                          <Select
                            aria-label={`${i + 1}행 계정 역할`}
                            value={line.slot}
                            onChange={(e) =>
                              setTemplateLines(
                                templateLines.map((l, j) => (j === i ? { ...l, slot: e.target.value } : l)),
                              )
                            }
                          >
                            <option value="">선택</option>
                            {(mappings.data ?? []).map((m) => (
                              <option key={m.slot} value={m.slot}>
                                {m.label}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className="px-2 py-1">
                          <Select
                            aria-label={`${i + 1}행 차/대`}
                            value={line.side}
                            onChange={(e) =>
                              setTemplateLines(
                                templateLines.map((l, j) =>
                                  j === i ? { ...l, side: e.target.value as 'DEBIT' | 'CREDIT' } : l,
                                ),
                              )
                            }
                          >
                            <option value="DEBIT">차변</option>
                            <option value="CREDIT">대변</option>
                          </Select>
                        </td>
                        <td className="px-2 py-1">
                          <Input
                            aria-label={`${i + 1}행 금액 항목`}
                            placeholder="supply, vat, total, cost..."
                            value={line.amountKey}
                            onChange={(e) =>
                              setTemplateLines(
                                templateLines.map((l, j) =>
                                  j === i ? { ...l, amountKey: e.target.value } : l,
                                ),
                              )
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <Input
                            aria-label={`${i + 1}행 적요`}
                            value={line.description ?? ''}
                            onChange={(e) =>
                              setTemplateLines(
                                templateLines.map((l, j) =>
                                  j === i ? { ...l, description: e.target.value } : l,
                                ),
                              )
                            }
                          />
                        </td>
                        <td className="px-2 py-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setTemplateLines(templateLines.filter((_, j) => j !== i))}
                          >
                            삭제
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" onClick={() => setTemplateLines([...templateLines, emptyTemplateLine()])}>
                  행 추가
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={publish.isPending}
                  onClick={() => void submitPublish()}
                >
                  {publish.isPending ? '발행 중' : '발행'}
                </Button>
                <Button size="sm" onClick={() => setPublishing(false)}>
                  취소
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card title="분개 미리보기">
        <div className="mb-3 max-w-xs">
          <Field label="규칙" htmlFor="pr-code" hint="공급가 1,000,000 / 부가세 100,000 기준">
            <Select id="pr-code" value={selected} onChange={(e) => setSelected(e.target.value)}>
              {(rules.data ?? []).map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {preview.isLoading ? (
          <Spinner />
        ) : preview.error ? (
          <EmptyState title="미리보기를 만들 수 없습니다." description={preview.error.message} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="border-b border-slate-200 text-left text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">계정과목</th>
                    <th className="px-2 py-1.5 font-medium">적요</th>
                    <th className="px-2 py-1.5 text-right font-medium">차변</th>
                    <th className="px-2 py-1.5 text-right font-medium">대변</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.data!.lines.map((l, i) => (
                    <tr key={`${l.slot}-${i}`} className="border-b border-slate-100">
                      <td className="px-2 py-1.5">
                        <span className="tabular text-slate-500">{l.accountCode ?? ''}</span> {l.accountName}
                      </td>
                      <td className="px-2 py-1.5">{l.description}</td>
                      <td className="tabular px-2 py-1.5 text-right">
                        {l.side === 'DEBIT' ? fmt.krw(l.amount) : ''}
                      </td>
                      <td className="tabular px-2 py-1.5 text-right">
                        {l.side === 'CREDIT' ? fmt.krw(l.amount) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-right text-sm">
              차변 <span className="tabular font-medium">{fmt.krw(preview.data!.totalDebit)}</span> · 대변{' '}
              <span className="tabular font-medium">{fmt.krw(preview.data!.totalCredit)}</span>{' '}
              {preview.data!.balanced ? (
                <span className="rounded bg-green-50 px-2 py-0.5 text-xs text-green-800">일치</span>
              ) : (
                <span className="rounded bg-red-50 px-2 py-0.5 text-xs text-red-700">불일치</span>
              )}
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
