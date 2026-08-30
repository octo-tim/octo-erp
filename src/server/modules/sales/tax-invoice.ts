import type { TransactionContext } from '@/server/core/context';
import { AppError } from '@/server/core/errors';
import { requirePermission } from '@/server/modules/rbac/service';
import * as audit from '@/server/modules/audit/service';
import { enqueue } from '@/server/modules/outbox/service';
import { formatBusinessNo } from '@/server/modules/master/validation';
import { TAX_TYPE_LABEL, type TaxType } from './pricing';
import { formatKrw, D } from '@/lib/money';

/**
 * SLS-07 — the in-house tax invoice form.
 *
 * This produces a document laid out like the NTS standard form, for internal use and for
 * sending to the customer. It is deliberately NOT an electronic tax invoice: nothing here
 * files anything with the tax office, and the form says so, because a document that looks
 * official but has not been filed is worse than no document at all.
 */

export const NOT_FILED_NOTICE = '본 서식은 사내 관리용이며 국세청에 전송된 전자세금계산서가 아닙니다.';

export interface SupplierInfo {
  businessNo: string;
  name: string;
  ceoName: string;
  address: string;
  businessType: string;
  businessItem: string;
}

async function supplierInfo(ctx: TransactionContext): Promise<SupplierInfo> {
  const row = await ctx.tx.systemSetting.findUnique({ where: { key: 'company.profile' } });
  const value = (row?.value ?? {}) as Partial<SupplierInfo>;
  return {
    businessNo: value.businessNo ?? '',
    name: value.name ?? '(주)옥토웍스',
    ceoName: value.ceoName ?? '',
    address: value.address ?? '',
    businessType: value.businessType ?? '',
    businessItem: value.businessItem ?? '',
  };
}

export interface TaxInvoiceData {
  docNo: string;
  docDate: string;
  supplier: SupplierInfo;
  buyer: {
    businessNo: string;
    name: string;
    ceoName: string;
    address: string;
    email: string;
  };
  lines: {
    lineNo: number;
    itemName: string;
    spec: string;
    quantity: string;
    unitPrice: string;
    supplyAmount: string;
    vatAmount: string;
    taxTypeLabel: string;
  }[];
  supplyAmount: string;
  vatAmount: string;
  totalAmount: string;
  notice: string;
}

export async function build(ctx: TransactionContext, documentId: string): Promise<TaxInvoiceData> {
  requirePermission(ctx.actor, 'sales.read');

  const doc = await ctx.tx.salesDocument.findUnique({
    where: { id: documentId },
    include: {
      partner: true,
      lines: { orderBy: { lineNo: 'asc' }, include: { item: true } },
    },
  });
  if (!doc) throw new AppError('NOT_FOUND', '매출전표를 찾을 수 없습니다.');
  if (doc.status !== 'CONFIRMED') {
    throw new AppError('VALIDATION', '확정된 매출전표만 세금계산서를 발행할 수 있습니다.');
  }

  return {
    docNo: doc.docNo,
    docDate: doc.docDate.toISOString().slice(0, 10),
    supplier: await supplierInfo(ctx),
    buyer: {
      businessNo: doc.partner.businessNo ? formatBusinessNo(doc.partner.businessNo) : '',
      name: doc.partner.name,
      ceoName: doc.partner.ceoName ?? '',
      address: doc.partner.address ?? '',
      email: doc.partner.email ?? '',
    },
    lines: doc.lines.map((l) => ({
      lineNo: l.lineNo,
      itemName: l.item.name,
      spec: l.item.spec ?? '',
      quantity: l.quantity.toString(),
      unitPrice: formatKrw(l.unitPrice.toString()),
      supplyAmount: formatKrw(l.supplyAmount.toString()),
      vatAmount: formatKrw(l.vatAmount.toString()),
      taxTypeLabel: TAX_TYPE_LABEL[l.taxType as TaxType] ?? l.taxType,
    })),
    supplyAmount: formatKrw(doc.supplyAmount.toString()),
    vatAmount: formatKrw(doc.vatAmount.toString()),
    totalAmount: formatKrw(doc.totalAmount.toString()),
    notice: NOT_FILED_NOTICE,
  };
}

/** The printable form as HTML, which the browser turns into a PDF. */
export function render(data: TaxInvoiceData): string {
  const rows = data.lines
    .map(
      (l) => `<tr>
        <td class="c">${l.lineNo}</td>
        <td>${escapeHtml(l.itemName)}</td>
        <td>${escapeHtml(l.spec)}</td>
        <td class="c">${l.taxTypeLabel}</td>
        <td class="r">${l.quantity}</td>
        <td class="r">${l.unitPrice}</td>
        <td class="r">${l.supplyAmount}</td>
        <td class="r">${l.vatAmount}</td>
      </tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>세금계산서 ${escapeHtml(data.docNo)}</title>
<style>
  body { font-family: -apple-system, 'Malgun Gothic', sans-serif; font-size: 12px; color: #111; margin: 24px; }
  h1 { font-size: 18px; text-align: center; letter-spacing: 8px; margin: 0 0 4px; }
  .sub { text-align: center; color: #666; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #666; padding: 4px 6px; }
  th { background: #f3f4f6; font-weight: 600; }
  .c { text-align: center; }
  .r { text-align: right; font-variant-numeric: tabular-nums; }
  .party { width: 50%; vertical-align: top; }
  .notice { margin-top: 16px; padding: 8px; border: 1px solid #d97706; background: #fffbeb; color: #92400e; }
  .totals th { width: 12%; }
  @media print { body { margin: 0; } }
</style></head>
<body>
  <h1>세 금 계 산 서</h1>
  <p class="sub">${escapeHtml(data.docNo)} · ${escapeHtml(data.docDate)}</p>

  <table>
    <tr>
      <td class="party">
        <strong>공급자</strong><br />
        등록번호 ${escapeHtml(data.supplier.businessNo)}<br />
        상호 ${escapeHtml(data.supplier.name)} / 대표 ${escapeHtml(data.supplier.ceoName)}<br />
        주소 ${escapeHtml(data.supplier.address)}<br />
        업태 ${escapeHtml(data.supplier.businessType)} / 종목 ${escapeHtml(data.supplier.businessItem)}
      </td>
      <td class="party">
        <strong>공급받는자</strong><br />
        등록번호 ${escapeHtml(data.buyer.businessNo)}<br />
        상호 ${escapeHtml(data.buyer.name)} / 대표 ${escapeHtml(data.buyer.ceoName)}<br />
        주소 ${escapeHtml(data.buyer.address)}<br />
        이메일 ${escapeHtml(data.buyer.email)}
      </td>
    </tr>
  </table>

  <table style="margin-top:8px">
    <thead>
      <tr>
        <th style="width:4%">#</th><th>품목</th><th style="width:14%">규격</th>
        <th style="width:8%">과세</th><th style="width:10%">수량</th><th style="width:12%">단가</th>
        <th style="width:14%">공급가액</th><th style="width:12%">세액</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <table class="totals" style="margin-top:8px">
    <tr>
      <th>공급가액</th><td class="r">${data.supplyAmount}</td>
      <th>세액</th><td class="r">${data.vatAmount}</td>
      <th>합계</th><td class="r"><strong>${data.totalAmount}</strong></td>
    </tr>
  </table>

  <p class="notice">${escapeHtml(data.notice)}</p>
</body></html>`;
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/**
 * SLS-07: records the issue and queues the email through the outbox, so the send is
 * retried on failure and never happens twice for one request (ADR-0012).
 */
export async function issue(
  ctx: TransactionContext,
  documentId: string,
  input: { email?: string; send?: boolean } = {},
) {
  requirePermission(ctx.actor, 'sales.write');
  const data = await build(ctx, documentId);
  const recipient = input.email ?? data.buyer.email;

  if (input.send && !recipient) {
    throw new AppError(
      'VALIDATION',
      '받는 사람 이메일이 없습니다. 거래처 이메일을 등록하거나 직접 입력하세요.',
    );
  }

  const output = await ctx.tx.taxDocumentOutput.create({
    data: {
      documentId,
      status: input.send ? 'GENERATED' : 'GENERATED',
      recipientEmail: recipient || null,
      createdById: ctx.actor.userId,
    },
  });

  if (input.send) {
    await enqueue(ctx, {
      topic: 'email.send',
      payload: {
        to: recipient,
        subject: `[${data.supplier.name}] 세금계산서 ${data.docNo}`,
        text: `${data.docNo} (${data.docDate}) 합계 ${data.totalAmount}원\n\n${NOT_FILED_NOTICE}`,
        html: render(data),
        taxDocumentOutputId: output.id,
      },
      dedupKey: `tax-invoice:${output.id}`,
    });
    await ctx.tx.taxDocumentOutput.update({
      where: { id: output.id },
      data: { status: 'SENT', sentAt: ctx.now },
    });
  }

  await audit.record(ctx, {
    action: 'taxInvoice.issue',
    entityType: 'SalesDocument',
    entityId: documentId,
    // INT-09: the recipient address is business data, but it is not repeated in the log body
    after: { outputId: output.id, sent: Boolean(input.send), docNo: data.docNo },
  });

  return { id: output.id, html: render(data), data };
}

export async function history(ctx: TransactionContext, documentId: string) {
  requirePermission(ctx.actor, 'sales.read');
  return ctx.tx.taxDocumentOutput.findMany({
    where: { documentId },
    orderBy: { createdAt: 'desc' },
  });
}

export { D };
