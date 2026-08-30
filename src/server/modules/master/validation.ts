/**
 * BAS-04: Korean business registration number (사업자등록번호) format and checksum.
 * The RFP allows partners without one (overseas suppliers, individuals), so validation
 * is only applied when a value is present.
 */
export function normalizeBusinessNo(value: string): string {
  return value.replace(/\D/g, '');
}

export function formatBusinessNo(value: string): string {
  const n = normalizeBusinessNo(value);
  return n.length === 10 ? `${n.slice(0, 3)}-${n.slice(3, 5)}-${n.slice(5)}` : value;
}

/** Returns null when valid, otherwise a message for the user. */
export function validateBusinessNo(value: string): string | null {
  const n = normalizeBusinessNo(value);
  if (n.length !== 10) return '사업자등록번호는 숫자 10자리여야 합니다.';

  // National Tax Service checksum: weights 1,3,7,1,3,7,1,3,5 plus a carry on the 9th digit.
  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(n[i]) * weights[i]!;
  sum += Math.floor((Number(n[8]) * 5) / 10);
  const check = (10 - (sum % 10)) % 10;

  return check === Number(n[9]) ? null : '사업자등록번호 확인번호가 올바르지 않습니다.';
}

/** BAS-01: barcode sanity check (EAN-13 / EAN-8 checksum) when a value is present. */
export function validateBarcode(value: string): string | null {
  const n = value.replace(/\D/g, '');
  if (n !== value.trim()) return '바코드는 숫자만 입력할 수 있습니다.';
  if (n.length !== 8 && n.length !== 13) return '바코드는 8자리 또는 13자리여야 합니다.';

  const digits = n.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check ? null : '바코드 체크디지트가 올바르지 않습니다.';
}

export const TAX_TYPES = ['TAXABLE', 'ZERO', 'EXEMPT'] as const;
export type TaxType = (typeof TAX_TYPES)[number];
export const TAX_TYPE_LABEL: Record<TaxType, string> = { TAXABLE: '과세', ZERO: '영세', EXEMPT: '면세' };

export const PARTNER_TYPES = ['CUSTOMER', 'SUPPLIER', 'BOTH'] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

export const WAREHOUSE_TYPES = ['NORMAL', 'DEFECT', 'CONSIGNED'] as const;
export type WarehouseType = (typeof WAREHOUSE_TYPES)[number];
