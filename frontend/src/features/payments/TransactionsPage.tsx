import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { apiClient } from '../../api/client';
import { paymentsApi, type SettlementResult, type TransactionDetail, type TransactionFilters, type TransactionPage } from './payments.api';
import { PaymentReviewForm } from './PaymentReviewForm';
import { money, paymentError, timestamp } from './payments-format';
import { InvoiceDetails, SettlementSummary } from './InvoiceDetails';

const initialFilters: TransactionFilters = { kind: '', status: 'PENDING', memberId: '', q: '', createdFrom: '', createdTo: '', page: 1 };
const statusLabels = { PENDING: 'Chờ thu', SETTLED: 'Đã hoàn tất', CANCELLED: 'Đã hủy' };

export function TransactionsPage() {
  const auth = useSyncExternalStore(apiClient.subscribe, apiClient.getSnapshot);
  const accountId = auth.status === 'authenticated' ? auth.user?.id : undefined;
  return accountId ? <TransactionsContent key={accountId} /> : <p>Vui lòng đăng nhập để tra cứu thanh toán.</p>;
}

function TransactionsContent() {
  const [form, setForm] = useState(initialFilters);
  const [filters, setFilters] = useState(initialFilters);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState<TransactionPage | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<TransactionDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailRetry, setDetailRetry] = useState(0);
  const [settlement, setSettlement] = useState<SettlementResult | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    let active = true;
    setPage(null); setError('');
    paymentsApi.list(filters).then(result => { if (active) setPage(result); }, reason => { if (active) setError(paymentError(reason)); });
    return () => { active = false; };
  }, [filters, retry]);

  useEffect(() => {
    const current = ++sequence.current;
    setDetail(null); setDetailError('');
    if (selected) paymentsApi.detail(selected).then(result => { if (current === sequence.current) setDetail(result); },
      reason => { if (current === sequence.current) setDetailError(paymentError(reason)); });
    return () => { sequence.current++; };
  }, [selected, detailRetry]);

  return <section className="auth-card">
    <h2>Tra cứu và đối chiếu thanh toán</h2>
    <form className="toolbar" onSubmit={event => { event.preventDefault(); setFilters({ ...form, page: 1 }); }}>
      <label>Mã giao dịch <input value={form.q} maxLength={40} onChange={e => setForm({ ...form, q: e.target.value })} /></label>
      <label>ID hội viên <input value={form.memberId} onChange={e => setForm({ ...form, memberId: e.target.value })} /></label>
      <label>Loại dịch vụ <select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}>
        <option value="">Tất cả</option><option value="GYM">GYM</option><option value="PT">PT</option></select></label>
      <label>Trạng thái <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
        <option value="">Tất cả</option><option value="PENDING">Chờ thu</option><option value="SETTLED">Đã hoàn tất</option><option value="CANCELLED">Đã hủy</option></select></label>
      <label>Tạo từ ngày <input type="date" value={form.createdFrom} onChange={e => setForm({ ...form, createdFrom: e.target.value })} /></label>
      <label>Tạo đến ngày <input type="date" value={form.createdTo} onChange={e => setForm({ ...form, createdTo: e.target.value })} /></label>
      <button type="submit">Tìm</button>
    </form>
    <p>Ngày và thời gian hiển thị theo giờ Việt Nam. Đối chiếu không xác nhận khoản thu trong hệ thống.</p>
    <section aria-label="Danh sách giao dịch">
      {error ? <div role="alert">{error} <button onClick={() => setRetry(value => value + 1)}>Thử lại</button></div>
        : !page ? <p role="status">Đang tải danh sách…</p> : !page.items.length ? <p>Không có giao dịch phù hợp.</p>
          : <><table><thead><tr><th>Mã</th><th>Khách hàng</th><th>Loại</th><th>Phải thu</th><th>Trạng thái</th><th>Ngày tạo</th><th>Thao tác</th></tr></thead>
            <tbody>{page.items.map(item => <tr key={item.id}><td>{item.code}</td><td>{item.member?.memberCode} – {item.member?.fullName ?? 'Thiếu hồ sơ'}</td>
              <td>{item.kind}</td><td>{money(item.amountDue)}</td><td>{statusLabels[item.status]}</td><td>{timestamp(item.createdAt)}</td>
              <td><button onClick={() => { setDetail(null); setSettlement(null); setSelected(item.id); setDetailRetry(value => value + 1); }}>Chi tiết {item.code}</button></td></tr>)}</tbody></table>
            <p>Trang {page.page}/{page.totalPages} · {page.total} giao dịch</p>
            <button disabled={page.page <= 1} onClick={() => setFilters({ ...filters, page: page.page - 1 })}>Trang trước</button>{' '}
            <button disabled={page.page >= page.totalPages} onClick={() => setFilters({ ...filters, page: page.page + 1 })}>Trang sau</button></>}
    </section>
    {selected && <section aria-label="Chi tiết giao dịch"><h3>Chi tiết giao dịch</h3>
      {detailError ? <div role="alert">{detailError} <button onClick={() => setDetailRetry(value => value + 1)}>Tải lại chi tiết</button></div>
        : !detail ? <p>Đang tải chi tiết…</p> : <>
          <p>{detail.transaction.code} · {statusLabels[detail.transaction.status]} · {detail.transaction.kind}</p>
          <p>Khách: {detail.transaction.member?.memberCode} – {detail.transaction.member?.fullName} · {detail.transaction.member?.phone}</p>
          <p>Số tiền phải thu: <strong>{money(detail.transaction.amountDue)}</strong></p>
          {detail.sale && <><p>Gói: {detail.sale.planName} · {detail.sale.startDate} – {detail.sale.endDate}</p>
            <p>{detail.sale.benefits} · {detail.sale.sessions} buổi</p><p>Điều khoản lúc bán: {detail.sale.policySnapshot}</p></>}
          <h4>Lịch sử khoản thu</h4>
          {!detail.payments.length ? <p>Chưa có khoản thu.</p> : detail.payments.map(item => <article key={item.id}>
            <p>{item.method} · {money(item.amount)} · {item.status} · {item.reference}</p>
            {item.paidAt && <p>Thực nhận: {timestamp(item.paidAt)}</p>}{item.evidenceNote && <p>Căn cứ: {item.evidenceNote}</p>}</article>)}
          {detail.invoice && <article><h4>Chứng từ {detail.invoice.invoiceNo}</h4><p>{money(detail.invoice.totalAmount)} · {timestamp(detail.invoice.issuedAt)}</p>
            <p>Người mua lúc lập: {detail.invoice.buyerSnapshot}</p>{!settlement && <InvoiceDetails id={detail.invoice.id} />}</article>}
          {detail.membershipId && <p>ID gói hội viên: {detail.membershipId}</p>}
          {detail.transaction.status === 'PENDING' && detail.transaction.amountDue !== '0'
            ? <PaymentReviewForm key={`${selected}:${detailRetry}`} transaction={detail.transaction} onRefresh={() => {
              setDetailRetry(current => current + 1); setRetry(current => current + 1);
            }} onSettled={value => {
              setSettlement(value); setDetailRetry(current => current + 1); setRetry(current => current + 1);
            }} />
            : <p>Giao dịch này không mở đối chiếu khoản thu mới.{detail.transaction.amountDue === '0' && ' Gói 0 đồng không cần thanh toán.'}</p>}
          <p>Dữ liệu lúc {timestamp(detail.asOf)}</p>
        </>}
    </section>}
    {settlement && <SettlementSummary result={settlement} />}
  </section>;
}
