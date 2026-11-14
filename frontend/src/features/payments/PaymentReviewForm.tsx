import { useRef, useState } from 'react';
import { paymentsApi, type PaymentReview, type PaymentReviewInput, type SettlementResult, type TransactionItem } from './payments.api';
import { money, paymentError, timestamp } from './payments-format';
import { PaymentConfirmation } from './PaymentConfirmation';

const reasons: Record<string, string> = {
  AMOUNT_MISMATCH: 'Số tiền đối chiếu phải bằng số tiền phải thu.',
  ZERO_PAYMENT_NOT_REQUIRED: 'Gói 0 đồng không cần khoản thu.',
  TRANSACTION_ALREADY_SETTLED: 'Giao dịch đã hoàn tất.', INVALID_TRANSACTION_STATE: 'Giao dịch không còn chờ thu.',
  PAYMENT_REFERENCE_USED: 'Tham chiếu đã được sử dụng. Đối chiếu khoản thu gốc; không đổi mã để vượt xung đột.',
  SALE_NOT_FOUND: 'Không có lần bán dịch vụ.', INVALID_SALE_STATE: 'Dữ liệu lần bán không đủ điều kiện cấp gói.',
  MEMBERSHIP_ALREADY_EXISTS: 'Lần bán đã có gói hội viên.', PAYMENT_ALREADY_SUCCEEDED: 'Giao dịch đã có khoản thu thành công.',
  CURRENT_SERVICE_EXISTS: 'Hội viên đang có gói cùng loại.', PENDING_SALE_EXISTS: 'Hội viên có giao dịch chờ khác cùng loại.',
};

export function PaymentReviewForm({ transaction, onSettled, onRefresh }: {
  transaction: TransactionItem; onSettled?: (result: SettlementResult) => void; onRefresh?: () => void;
}) {
  const [method, setMethod] = useState<'CASH' | 'TRANSFER'>('CASH');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [account, setAccount] = useState('');
  const [reference, setReference] = useState('');
  const [receivedAt, setReceivedAt] = useState('');
  const [verified, setVerified] = useState(false);
  const [result, setResult] = useState<PaymentReview | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [confirmLocked, setConfirmLocked] = useState(false);
  const busy = useRef(false);
  function invalidate() { setResult(null); setError(''); }
  const input: PaymentReviewInput = { method, amount, evidenceNote: note.trim(), ...(method === 'TRANSFER'
    ? { receivingAccountCode: account, bankReference: reference.trim(), receivedAt } : {}) };

  async function preview() {
    if (busy.current || !verified || confirmLocked) return;
    busy.current = true; setPending(true); setResult(null); setError('');
    try { setResult(await paymentsApi.preview(transaction.id, input)); }
    catch (reason) { setError(paymentError(reason)); }
    finally { busy.current = false; setPending(false); }
  }

  return <form aria-label="Đối chiếu khoản thu" onSubmit={event => { event.preventDefault(); void preview(); }}>
    <h4>Đối chiếu khoản thu</h4>
    <p>Phải thu theo giao dịch: <strong>{money(transaction.amountDue)}</strong></p>
    <fieldset disabled={pending || confirmLocked}>
      <label>Phương thức <select value={method} onChange={e => { setMethod(e.target.value as 'CASH' | 'TRANSFER'); setVerified(false); invalidate(); }}>
        <option value="CASH">Tiền mặt</option><option value="TRANSFER">Chuyển khoản</option></select></label>
      <label>Số tiền đối chiếu (VND) <input required inputMode="numeric" pattern="[0-9]{1,12}" value={amount} onChange={e => { setAmount(e.target.value); invalidate(); }} /></label>
      <label>Căn cứ kiểm tra thực tế <textarea required minLength={10} maxLength={500} value={note} onChange={e => { setNote(e.target.value); invalidate(); }} /></label>
      <p>Ghi căn cứ đã đếm tiền hoặc sổ phụ/báo có thực tế. Ảnh chuyển khoản của người mua chưa đủ căn cứ. Không nhập mật khẩu hoặc thông tin đăng nhập.</p>
      {method === 'TRANSFER' && <>
        <label>Mã tài khoản nhận đã cấu hình <input required pattern="[A-Z0-9_-]{1,40}" value={account} onChange={e => { setAccount(e.target.value); invalidate(); }} /></label>
        <label>Tham chiếu ngân hàng thực tế <input required maxLength={100} value={reference} onChange={e => { setReference(e.target.value); invalidate(); }} /></label>
        <label>Thời điểm báo có (ISO8601 kèm múi giờ) <input required placeholder="2026-11-14T10:00:00+07:00" value={receivedAt} onChange={e => { setReceivedAt(e.target.value); invalidate(); }} /></label>
      </>}
      <label><input type="checkbox" checked={verified} onChange={e => { setVerified(e.target.checked); invalidate(); }} />
        {method === 'CASH' ? 'Tôi đã thực đếm số tiền nhận.' : 'Tôi đã kiểm tra báo có thực tế của tài khoản nhận; không chỉ dựa vào ảnh người mua.'}</label>
      <button type="submit" disabled={!verified || note.trim().length < 10}>{pending ? 'Đang đối chiếu…' : 'Kiểm tra đối chiếu'}</button>
    </fieldset>
    {!verified && <p>Chưa đủ căn cứ (NEEDS_REVIEW): cần đếm tiền hoặc đối chiếu báo có thực tế.</p>}
    {error && <p role="alert">{error} Thông tin nhập được giữ để kiểm tra và thử lại.</p>}
    {result && <div role="status"><p>{result.reviewState === 'READY' ? 'Đủ điều kiện tại thời điểm kiểm tra (READY)' : result.reviewState === 'NEEDS_REVIEW' ? 'Cần đối chiếu lại (NEEDS_REVIEW)' : 'Bị chặn (BLOCKED)'}</p>
      <p>Phải thu: {money(result.amountDue)} · Số đối chiếu: {money(amount)}</p>
      {result.normalizedReference && <p>Tham chiếu chuẩn: {result.normalizedReference}</p>}
      <ul>{result.blockingCodes.map(code => <li key={code}>{reasons[code] ?? code}</li>)}</ul>
      <p>Kiểm tra lúc {timestamp(result.asOf)}. Kết quả không giữ tham chiếu và chưa xác nhận thanh toán.</p>
    </div>}
    <PaymentConfirmation transactionId={transaction.id} input={result?.canConfirm ? input : null}
      onLockedChange={setConfirmLocked} onSettled={onSettled} onRejected={code => {
        setResult(null);
        if (code === 'TRANSACTION_ALREADY_SETTLED' || code === 'INVALID_TRANSACTION_STATE') onRefresh?.();
      }} />
  </form>;
}
