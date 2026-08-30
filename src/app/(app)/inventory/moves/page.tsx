'use client';

import { StockDocumentList } from '@/components/inventory/stock-document-list';

/** INV-03: warehouse transfers move through 요청 → 이동중 → 완료. */
export default function StockMovePage() {
  return (
    <StockDocumentList
      docType="TRANSFER"
      title="창고이동"
      description="출발·도착 창고 간 이동입니다. 도착 처리(완료) 시점에 양쪽 창고 재고가 동시에 반영됩니다."
      createLabel="이동 등록"
    />
  );
}
