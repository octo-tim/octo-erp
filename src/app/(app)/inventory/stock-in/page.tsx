'use client';

import { StockDocumentList } from '@/components/inventory/stock-document-list';

/** INV-01: manual receipts. Purchase-linked receipts arrive from the purchase module. */
export default function StockInPage() {
  return (
    <StockDocumentList
      docType="RECEIPT"
      title="입고"
      description="매입 연동 입고와 사유가 있는 수동 입고를 등록합니다. 확정 시 재고 원장에 반영됩니다."
      createLabel="입고 등록"
    />
  );
}
