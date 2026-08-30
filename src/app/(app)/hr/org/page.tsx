'use client';

import { useState } from 'react';
import { api } from '@/lib/trpc';
import { Card, EmptyState, Field, Input, Spinner } from '@/components/ui/primitives';
import { fmt } from '@/lib/format';
import { businessDate } from '@/lib/dates';

/** HRM-02: org chart with point-in-time lookup and reorganisation history. */
interface Node {
  id: string;
  code: string;
  name: string;
  children: Node[];
}

export default function OrgChartPage() {
  const [asOf, setAsOf] = useState(businessDate());
  const chart = api.hrm.orgChart.useQuery({ asOf });
  const history = api.hrm.departmentHistory.useQuery({});

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">조직도</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            기준일을 바꾸면 그 시점의 조직 구조를 그대로 재현합니다.
          </p>
        </div>
        <Field label="기준일" htmlFor="org-asof" className="w-44">
          <Input id="org-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
      </header>

      <Card title={`${asOf} 기준 조직`}>
        {chart.isLoading ? (
          <Spinner />
        ) : (chart.data ?? []).length === 0 ? (
          <EmptyState
            title="해당 기준일에 유효한 부서가 없습니다."
            description="기준일을 조정해 다시 조회하세요."
          />
        ) : (
          <ul className="text-sm">
            {(chart.data as unknown as Node[]).map((n) => (
              <TreeNode key={n.id} node={n} depth={0} />
            ))}
          </ul>
        )}
      </Card>

      <Card title="조직 개편 이력">
        {history.isLoading ? (
          <Spinner />
        ) : (history.data ?? []).length === 0 ? (
          <EmptyState title="개편 이력이 없습니다." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    시행일
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    부서
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    변경유형
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    비고
                  </th>
                </tr>
              </thead>
              <tbody>
                {(history.data ?? []).map((h) => (
                  <tr key={h.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-1.5">{fmt.date(h.effectiveDate as unknown as string)}</td>
                    <td className="px-3 py-1.5">{h.department?.name ?? '-'}</td>
                    <td className="px-3 py-1.5">{CHANGE_LABEL[h.changeType] ?? h.changeType}</td>
                    <td className="px-3 py-1.5">{h.note ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

const CHANGE_LABEL: Record<string, string> = {
  CREATED: '신설',
  RENAMED: '명칭변경',
  MOVED: '소속이동',
  HEAD_CHANGED: '부서장변경',
  CLOSED: '폐지',
  REORG: '개편',
};

function TreeNode({ node, depth }: { node: Node; depth: number }) {
  return (
    <li>
      <div className="flex items-center gap-2 py-1" style={{ paddingLeft: depth * 20 }}>
        <span className="text-slate-400" aria-hidden>
          {depth === 0 ? '■' : '└'}
        </span>
        <span className="font-medium">{node.name}</span>
        <span className="text-xs text-slate-500">{node.code}</span>
      </div>
      {node.children.length > 0 ? (
        <ul>
          {node.children.map((c) => (
            <TreeNode key={c.id} node={c} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
