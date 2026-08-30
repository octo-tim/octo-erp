'use client';

import { api } from '@/lib/trpc';
import { Select } from '@/components/ui/primitives';

/**
 * A partner picker filtered by which side of the trade it is for, so a purchase document
 * cannot accidentally be raised against a customer-only partner.
 */
export function PartnerSelect({
  id,
  value,
  onChange,
  partnerType,
  includeAll,
  ariaLabel,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  partnerType?: 'CUSTOMER' | 'SUPPLIER';
  includeAll?: boolean;
  ariaLabel?: string;
}) {
  const partners = api.master.searchPartners.useQuery({
    q: '',
    ...(partnerType ? { partnerType } : {}),
    take: 300,
  });

  return (
    <Select
      id={id}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{includeAll ? '전체' : '선택'}</option>
      {(partners.data ?? []).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </Select>
  );
}
