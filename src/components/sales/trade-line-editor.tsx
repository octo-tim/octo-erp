'use client';

import { useCallback, useMemo, useState } from 'react';
import { api } from '@/lib/trpc';
import { VoucherLineEditor, type LineColumn } from '@/components/ui/voucher-line-editor';
import { fmt } from '@/lib/format';
import { priceLine } from '@/server/modules/sales/pricing';
import { itemLabel, matchErrorText, resolveItemLabels, searchTermOf } from '@/lib/item-match';
import { add, D } from '@/lib/money';

/**
 * The line grid shared by every trade document (SLS-01/03/05/06/13).
 *
 * The amounts shown here come from the SAME pricing function the server uses (DEC-02), so
 * the operator sees the figure that will be stored rather than an approximation that
 * changes on save. The server still recomputes on submit — this is display only.
 */
export interface TradeLine extends Record<string, string> {
  itemLabel: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxType: string;
  supplyAmount: string;
  vatAmount: string;
}

export const emptyTradeLine = (): TradeLine => ({
  itemLabel: '',
  description: '',
  quantity: '',
  unitPrice: '',
  taxType: 'TAXABLE',
  supplyAmount: '',
  vatAmount: '',
});

/**
 * CR-14: turns the typed item cells of a document into ids, asking the server so that the
 * answer does not depend on how much of the item master the browser happened to load.
 * Returns either every id in line order, or a message per offending line.
 */
export function useItemResolver() {
  const utils = api.useUtils();
  return useCallback(
    async (labels: string[]): Promise<{ ids: string[] } | { errors: string[] }> => {
      const matches = await resolveItemLabels(labels, (term) =>
        utils.master.searchItems.fetch({ q: term, take: 5 }),
      );
      const errors = matches.map((m, i) => matchErrorText(i + 1, m)).filter((m): m is string => m !== null);
      if (errors.length > 0) return { errors };
      return { ids: matches.map((m) => (m as { kind: 'OK'; id: string }).id) };
    },
    [utils],
  );
}

export function recomputeTradeLine(line: TradeLine): TradeLine {
  if (!line.quantity || !line.unitPrice) return { ...line, supplyAmount: '', vatAmount: '' };
  try {
    const priced = priceLine({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      taxType: line.taxType || 'TAXABLE',
    });
    return { ...line, supplyAmount: priced.supplyAmount, vatAmount: priced.vatAmount };
  } catch {
    // an in-progress value (a lone '-', an empty decimal) simply has no amount yet
    return { ...line, supplyAmount: '', vatAmount: '' };
  }
}

export function TradeLineEditor({
  lines,
  onChange,
  disabled,
}: {
  lines: TradeLine[];
  onChange: (lines: TradeLine[]) => void;
  disabled?: boolean;
}) {
  // the suggestion list follows what is being typed; it is a hint, not the master (CR-14)
  const [itemQuery, setItemQuery] = useState('');
  const items = api.master.searchItems.useQuery({ q: itemQuery, take: 20 });
  const suggestions = useMemo(
    () => (items.data ?? []).map((i) => ({ value: i.id, label: itemLabel(i) })),
    [items.data],
  );

  const handleChange = useCallback(
    (next: TradeLine[]) => {
      const changed = next.find((l, i) => l.itemLabel !== (lines[i]?.itemLabel ?? ''));
      if (changed) setItemQuery(searchTermOf(changed.itemLabel));
      onChange(next);
    },
    [lines, onChange],
  );

  const columns: LineColumn<TradeLine>[] = [
    { key: 'itemLabel', header: '품목', kind: 'text', required: true, suggestions },
    { key: 'description', header: '적요', kind: 'text' },
    { key: 'quantity', header: '수량', kind: 'qty', width: 100, required: true },
    { key: 'unitPrice', header: '단가', kind: 'unitPrice', width: 110, required: true },
    {
      key: 'taxType',
      header: '과세',
      kind: 'select',
      width: 90,
      options: [
        { value: 'TAXABLE', label: '과세' },
        { value: 'ZERO', label: '영세' },
        { value: 'EXEMPT', label: '면세' },
      ],
    },
    { key: 'supplyAmount', header: '공급가액', kind: 'readonly', width: 120, total: true },
    { key: 'vatAmount', header: '세액', kind: 'readonly', width: 100, total: true },
  ];

  return (
    <VoucherLineEditor<TradeLine>
      columns={columns}
      lines={lines}
      onChange={handleChange}
      newLine={emptyTradeLine}
      recompute={recomputeTradeLine}
      {...(disabled ? { disabled } : {})}
    />
  );
}

/** The totals strip under the grid, computed with the same rule as the server. */
export function TradeTotals({ lines }: { lines: TradeLine[] }) {
  // INT-01: amounts are added as decimals, never as JavaScript numbers, even for display
  const supply = lines.reduce((acc, l) => add(acc, l.supplyAmount || '0'), D(0));
  const vat = lines.reduce((acc, l) => add(acc, l.vatAmount || '0'), D(0));
  return (
    <p className="mt-2 flex flex-wrap justify-end gap-4 text-sm">
      <span>
        공급가액 <span className="tabular font-medium">{fmt.krw(supply.toString())}</span>
      </span>
      <span>
        세액 <span className="tabular font-medium">{fmt.krw(vat.toString())}</span>
      </span>
      <span>
        합계 <span className="tabular font-semibold">{fmt.krw(add(supply, vat).toString())}</span>
      </span>
    </p>
  );
}

export { fmt };
