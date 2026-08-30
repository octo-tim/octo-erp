// covers: BAS-01, BAS-04
import { describe, expect, it } from 'vitest';
import {
  formatBusinessNo,
  normalizeBusinessNo,
  validateBarcode,
  validateBusinessNo,
} from '@/server/modules/master/validation';

describe('사업자등록번호 (BAS-04)', () => {
  it('accepts real check digits, with or without hyphens', () => {
    // 220-81-62517 (Naver) and 124-81-00998 (Samsung Electronics) are valid public numbers
    expect(validateBusinessNo('220-81-62517')).toBeNull();
    expect(validateBusinessNo('2208162517')).toBeNull();
    expect(validateBusinessNo('124-81-00998')).toBeNull();
  });

  it('rejects a wrong check digit', () => {
    expect(validateBusinessNo('220-81-62518')).toMatch(/확인번호/);
    expect(validateBusinessNo('123-45-67890')).toMatch(/확인번호/);
  });

  it('rejects the wrong length', () => {
    expect(validateBusinessNo('220-81-6251')).toMatch(/10자리/);
    expect(validateBusinessNo('')).toMatch(/10자리/);
    expect(validateBusinessNo('22081625170')).toMatch(/10자리/);
  });

  it('normalises and formats consistently', () => {
    expect(normalizeBusinessNo('220-81-62517')).toBe('2208162517');
    expect(formatBusinessNo('2208162517')).toBe('220-81-62517');
    expect(formatBusinessNo('abc')).toBe('abc');
  });
});

describe('바코드 (BAS-01)', () => {
  it('accepts valid EAN-13 and EAN-8', () => {
    expect(validateBarcode('8801234567893')).toBeNull();
    expect(validateBarcode('96385074')).toBeNull();
  });

  it('rejects a wrong check digit, length or non-digits', () => {
    expect(validateBarcode('8801234567890')).toMatch(/체크디지트/);
    expect(validateBarcode('12345')).toMatch(/8자리 또는 13자리/);
    expect(validateBarcode('88012A4567895')).toMatch(/숫자만/);
  });
});
