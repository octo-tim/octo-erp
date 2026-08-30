'use client';

import { StockDocumentList } from '@/components/inventory/stock-document-list';

/** INV-02: manual issues (samples, disposal). Sales-linked issues arrive from the sales module. */
export default function StockOutPage() {
  return (
    <StockDocumentList
      docType="ISSUE"
      title="출고"
      description="매출 연동 출고와 샘플·폐기 등 사유가 있는 수동 출고를 등록합니다. 출고 단가는 월 총평균법으로 산정됩니다."
      createLabel="출고 등록"
    />
  );
}
