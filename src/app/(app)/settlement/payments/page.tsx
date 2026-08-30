'use client';

import { SettlementScreen } from '@/components/sales/settlement-screen';

/** SLS-10: payments against outstanding payables. */
export default function PaymentsPage() {
  return (
    <SettlementScreen
      docType="PAYMENT"
      title="지급"
      description="출금을 등록한 뒤 미지급금에 배분합니다. 자동 배분은 오래된 미결부터 처리합니다."
      partnerLabel="매입처"
      partnerType="SUPPLIER"
    />
  );
}
