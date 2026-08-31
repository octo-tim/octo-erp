'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/trpc';
import { fmt } from '@/lib/format';
import { Spinner, StatusBadge } from '@/components/ui/primitives';
import { ReportTable, type ReportColumn } from '@/components/report/report-table';

/**
 * RPT-08 — the documents behind an aggregate.
 *
 * The conditions arrive in the URL, so a drill-down is a link the reader can bookmark or
 * send to a colleague, and the server applies the same scope it applied to the total. A
 * colleague with a narrower scope opening the same link sees their own rows, not an error
 * and not someone else's.
 */

type Row = {
  id: string;
  docNo: string;
  docDate: string;
  partnerName: string;
  amount: string;
  status: string;
  href: string;
};

const TARGET_LABEL: Record<string, string> = {
  SALES: '매출전표',
  PURCHASE: '매입전표',
  RECEIVABLE: '미수금',
  PAYABLE: '미지급금',
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '작성중',
  PENDING_APPROVAL: '결재중',
  CONFIRMED: '확정',
  CANCELED: '취소',
  OPEN: '미결제',
  PARTIAL: '부분결제',
  SETTLED: '결제완료',
};

function DrillDown() {
  const params = useSearchParams();
  const target = (params.get('target') ?? 'SALES') as 'SALES' | 'PURCHASE' | 'RECEIVABLE' | 'PAYABLE';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const itemId = params.get('itemId') ?? undefined;

  const filter = {
    from,
    to,
    ...(params.get('divisionId') ? { divisionId: params.get('divisionId')! } : {}),
    ...(params.get('warehouseId') ? { warehouseId: params.get('warehouseId')! } : {}),
    ...(params.get('partnerId') ? { partnerId: params.get('partnerId')! } : {}),
  };

  const q = api.report.drillDown.useQuery(
    { filter, target, ...(itemId ? { itemId } : {}), take: 200 },
    { enabled: !!from && !!to },
  );

  const columns: ReportColumn<Row>[] = [
    {
      key: 'docNo',
      header: '전표번호',
      render: (r) => (
        <Link className="underline" href={r.href}>
          {r.docNo}
        </Link>
      ),
    },
    { key: 'docDate', header: '일자' },
    { key: 'partnerName', header: '거래처' },
    { key: 'amount', header: '금액', numeric: true, render: (r) => fmt.krw(r.amount) },
    {
      key: 'status',
      header: '상태',
      render: (r) => <StatusBadge status={r.status} label={STATUS_LABEL[r.status] ?? r.status} />,
    },
  ];

  if (!from || !to) {
    return (
      <p className="text-sm text-slate-500">조회 기간이 지정되지 않았습니다. 보고서에서 다시 이동하세요.</p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">{TARGET_LABEL[target] ?? target} 상세</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {from} ~ {to}
          {q.data && q.data.total > q.data.rows.length
            ? ` · 전체 ${fmt.count(q.data.total)}건 중 ${fmt.count(q.data.rows.length)}건 표시`
            : ''}
        </p>
      </header>

      {q.isLoading ? (
        <Spinner />
      ) : (
        <ReportTable<Row>
          reportKey={`drilldown-${target}`}
          title={`${TARGET_LABEL[target] ?? target} 상세`}
          period={`${from} ~ ${to}`}
          columns={columns}
          rows={(q.data?.rows ?? []) as Row[]}
        />
      )}
    </div>
  );
}

export default function DrillDownPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <DrillDown />
    </Suspense>
  );
}
