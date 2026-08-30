'use client';

import { SettlementScreen } from '@/components/sales/settlement-screen';

/** SLS-10: receipts against outstanding receivables. */
export default function ReceiptsPage() {
  return (
    <SettlementScreen
      docType="RECEIPT"
      title="수금"
      description="입금을 등록한 뒤 미수금에 배분합니다. 자동 배분은 오래된 미결부터 처리하며, 수동 재배분 이력이 남습니다."
      partnerLabel="거래처"
      partnerType="CUSTOMER"
    />
  );
}
