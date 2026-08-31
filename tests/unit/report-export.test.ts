import { describe, expect, it } from 'vitest';
import { INTERNAL_NOTICE, fileNameFor, toCsv, type ExportColumn } from '@/lib/report-export';

interface Row extends Record<string, unknown> {
  name: string;
  amount: string;
  note: string;
}

const columns: ExportColumn<Row>[] = [
  { key: 'name', header: '거래처' },
  { key: 'amount', header: '금액', numeric: true },
  { key: 'note', header: '비고' },
];

describe('RPT-07 내보내기', () => {
  it('머리글과 행을 순서대로 쓴다', () => {
    const csv = toCsv(columns, [{ name: '한빛상사', amount: '1000', note: '' }]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toContain('거래처,금액,비고');
    expect(lines[1]).toBe('한빛상사,1000,');
  });

  it('쉼표·따옴표·줄바꿈이 든 값을 깨뜨리지 않는다', () => {
    const csv = toCsv(columns, [
      { name: '가, 나', amount: '10', note: '그가 "네"라고 했다' },
      { name: '두\n줄', amount: '20', note: '' },
    ]);
    expect(csv).toContain('"가, 나"');
    expect(csv).toContain('"그가 ""네""라고 했다"');
    expect(csv).toContain('"두\n줄"');
  });

  it('엑셀이 한글을 깨지 않도록 BOM으로 시작한다', () => {
    expect(toCsv(columns, []).charCodeAt(0)).toBe(0xfeff);
  });

  it('제목·기간·고지문구를 본문 앞에 넣는다', () => {
    const csv = toCsv(columns, [], {
      title: '매출현황',
      period: '2026-06-01 ~ 2026-06-30',
      notice: INTERNAL_NOTICE,
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toContain('매출현황');
    expect(lines[1]).toContain('2026-06-01');
    expect(lines[2]).toContain('사내 관리용');
    expect(lines[3]).toBe('');
  });

  it('빈 값과 없는 값을 같은 빈 칸으로 쓴다', () => {
    const csv = toCsv(columns, [{ name: 'A' } as Row]);
    expect(csv.split('\r\n')[1]).toBe('A,,');
  });

  it('파일명에 경로나 특수문자가 섞이지 않는다', () => {
    expect(fileNameFor('../../etc/passwd', '2026-06-01 ~ 2026-06-30')).toBe(
      'etcpasswd_2026-06-012026-06-30.csv',
    );
  });
});
