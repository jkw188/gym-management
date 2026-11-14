import { useEffect, useState } from 'react';
import { paymentsApi, type InvoiceDetail, type SettlementResult } from './payments.api';
import { money, paymentError, timestamp } from './payments-format';

function buyerLabel(snapshot: string) {
  try {
    const buyer: unknown = JSON.parse(snapshot);
    if (buyer && typeof buyer === 'object') {
      const values = buyer as Record<string, unknown>;
      const fields = [values.fullName, values.memberCode, values.phone].filter((value): value is string => typeof value === 'string');
      if (fields.length) return fields.join(' · ');
    }
  } catch { /* Historical snapshots can be plain text. */ }
  return snapshot;
}

export function InvoiceDetails({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setInvoice(null); setError('');
    if (open) paymentsApi.invoice(id).then(value => { if (active) setInvoice(value); }, reason => { if (active) setError(paymentError(reason)); });
    return () => { active = false; };
  }, [id, open, retry]);
  return <section aria-label="Chứng từ nội bộ">
    <button type="button" onClick={() => setOpen(value => !value)}>{open ? 'Ẩn chứng từ' : 'Xem chứng từ'}</button>
    {open && (error ? <p role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>Tải lại chứng từ</button></p>
      : !invoice ? <p>Đang tải chứng từ…</p> : <article>
        <h4>Chứng từ {invoice.invoiceNo}</h4><p>Giao dịch: {invoice.transactionCode}</p>
        <p>Ngày lập: {timestamp(invoice.issuedAt)} · Tổng tiền: {money(invoice.totalAmount)}</p>
        <p>Người mua lúc lập: {buyerLabel(invoice.buyerSnapshot)}</p>
        {invoice.serviceLine && <><p>{invoice.serviceLine.kind} · {invoice.serviceLine.planName}</p>
          <p>{invoice.serviceLine.benefits} · {invoice.serviceLine.sessions} buổi</p>
          <p>Kỳ dịch vụ: {invoice.serviceLine.startDate} – {invoice.serviceLine.endDate} (bao gồm ngày cuối)</p>
          <p>Giá gốc: {money(invoice.serviceLine.listPrice)} · Khấu trừ: {money(invoice.serviceLine.creditAmount)}</p></>}
        {invoice.payment ? <><p>Khoản thu: {invoice.payment.method} · {money(invoice.payment.amount)} · {invoice.payment.reference}</p>
          {invoice.payment.paidAt && <p>Thực nhận: {timestamp(invoice.payment.paidAt)}</p>}</> : <p>Chứng từ không có khoản thu tiền.</p>}
      </article>)}
  </section>;
}

export function SettlementSummary({ result }: { result: SettlementResult }) {
  return <section aria-label="Kết quả xác nhận thu"><h3>Đã xác nhận khoản thu</h3>
    <p>{result.transactionCode} · Đã hoàn tất (SETTLED)</p><p>Chứng từ: {result.invoiceNo}</p>
    <p>Kỳ gói thực tế: {result.startDate} – {result.endDate} (bao gồm ngày cuối)</p>
    <p>Mã gói hội viên: {result.membershipId}</p>
    <p>{result.notificationState === 'NO_LINKED_ACCOUNT' ? 'Thông báo đã lưu; hội viên chưa có tài khoản nhận.' : 'Thông báo đã được lưu.'}</p>
    <InvoiceDetails id={result.invoiceId} />
  </section>;
}
