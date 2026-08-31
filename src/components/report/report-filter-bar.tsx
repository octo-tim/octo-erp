'use client';

import { useEffect, useRef } from 'react';
import { api } from '@/lib/trpc';
import { Button, Field, Input, Select } from '@/components/ui/primitives';

/**
 * RPT-07 — the filter every report screen puts at the top.
 *
 * It is one component rather than one per report so that the conditions mean the same
 * thing everywhere, and so that a user moving between reports carries their period with
 * them. The last-used conditions are saved per user and per report; a report opened fresh
 * shows the current month rather than an empty form the user has to fill in before seeing
 * anything.
 */

export interface ReportFilterValue {
  from: string;
  to: string;
  divisionId?: string;
  warehouseId?: string;
  partnerId?: string;
  categoryId?: string;
}

export function currentMonth(): ReportFilterValue {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export function ReportFilterBar({
  reportKey,
  value,
  onChange,
  onSearch,
  show = {},
  actions,
}: {
  reportKey: string;
  value: ReportFilterValue;
  onChange: (v: ReportFilterValue) => void;
  onSearch: () => void;
  show?: { division?: boolean; warehouse?: boolean; partner?: boolean; category?: boolean };
  actions?: React.ReactNode;
}) {
  const divisions = api.master.divisions.useQuery({}, { enabled: !!show.division });
  const warehouses = api.master.warehouses.useQuery({ activeOnly: true }, { enabled: !!show.warehouse });
  const categories = api.master.itemCategories.useQuery(undefined, { enabled: !!show.category });
  const partners = api.master.searchPartners.useQuery({ q: '', take: 200 }, { enabled: !!show.partner });

  const saved = api.preference.get.useQuery({ kind: 'REPORT_FILTER', key: reportKey });
  const setSaved = api.preference.set.useMutation();

  /**
   * Refs, not state: neither of these is rendered, and making them state would re-render
   * the form to record something nobody looks at.
   *
   * `touched` is what stops the restore from stealing the user's typing. The saved
   * conditions arrive over the network, so on a slow connection they can land *after* the
   * user has already started filling the form — and applying them then would wipe out what
   * they just typed and search on something else entirely. Restoring is only ever right
   * while the form is still untouched.
   */
  const restored = useRef(false);
  const touched = useRef(false);

  useEffect(() => {
    if (restored.current || touched.current || saved.isLoading) return;
    restored.current = true;
    const v = saved.data as ReportFilterValue | null;
    if (v?.from && v?.to) onChange(v);
  }, [saved.isLoading, saved.data, onChange]);

  /** Every control changes the filter through here, so nothing can forget to mark it. */
  function edit(next: ReportFilterValue) {
    touched.current = true;
    onChange(next);
  }

  function search() {
    setSaved.mutate({ kind: 'REPORT_FILTER', key: reportKey, value });
    onSearch();
  }

  const id = (name: string) => `rf-${reportKey}-${name}`;

  return (
    <form
      className="rounded-lg border border-slate-200 bg-white p-4 print:hidden"
      aria-label="보고서 조회조건"
      onSubmit={(e) => {
        e.preventDefault();
        search();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="시작일" htmlFor={id('from')}>
          <Input
            id={id('from')}
            type="date"
            value={value.from}
            onChange={(e) => edit({ ...value, from: e.target.value })}
          />
        </Field>
        <Field label="종료일" htmlFor={id('to')}>
          <Input
            id={id('to')}
            type="date"
            value={value.to}
            onChange={(e) => edit({ ...value, to: e.target.value })}
          />
        </Field>

        {show.division ? (
          <Field label="사업부" htmlFor={id('division')}>
            <Select
              id={id('division')}
              value={value.divisionId ?? ''}
              onChange={(e) => edit({ ...value, divisionId: e.target.value || undefined })}
            >
              <option value="">전체</option>
              {(divisions.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {show.warehouse ? (
          <Field label="창고" htmlFor={id('warehouse')}>
            <Select
              id={id('warehouse')}
              value={value.warehouseId ?? ''}
              onChange={(e) => edit({ ...value, warehouseId: e.target.value || undefined })}
            >
              <option value="">전체</option>
              {(warehouses.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {show.partner ? (
          <Field label="거래처" htmlFor={id('partner')}>
            <Select
              id={id('partner')}
              value={value.partnerId ?? ''}
              onChange={(e) => edit({ ...value, partnerId: e.target.value || undefined })}
            >
              <option value="">전체</option>
              {(partners.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {show.category ? (
          <Field label="품목분류" htmlFor={id('category')}>
            <Select
              id={id('category')}
              value={value.categoryId ?? ''}
              onChange={(e) => edit({ ...value, categoryId: e.target.value || undefined })}
            >
              <option value="">전체</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5">
        {actions}
        <Button type="button" size="sm" onClick={() => edit(currentMonth())}>
          당월
        </Button>
        <Button type="submit" size="sm" variant="primary">
          조회
        </Button>
      </div>
    </form>
  );
}
