import { useEffect, useRef, useState } from 'react';
import { ApiError, apiClient } from '../../api/client';
import { paymentsApi, type PaymentReviewInput, type SettlementResult } from './payments.api';
import { money, paymentError, timestamp } from './payments-format';
import { InvoiceDetails, SettlementSummary } from './InvoiceDetails';

interface PaymentCommand { key: string; input: PaymentReviewInput }
function recover(storageKey: string): PaymentCommand | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (!value || typeof value !== 'object' || !('key' in value) || !('input' in value)) return null;
    const command = value as PaymentCommand;
    if (typeof command.key !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(command.key)) return null;
    if (!command.input || !['CASH', 'TRANSFER'].includes(command.input.method) || typeof command.input.amount !== 'string' ||
      !/^\d{1,12}$/.test(command.input.amount) || typeof command.input.evidenceNote !== 'string' ||
      command.input.evidenceNote.trim().length < 10 || command.input.evidenceNote.length > 500) return null;
    return command;
  } catch { return null; }
}

export function PaymentConfirmation({ transactionId, input, onLockedChange, onSettled, onRejected }: {
  transactionId: string; input: PaymentReviewInput | null; onLockedChange: (locked: boolean) => void;
  onSettled?: (result: SettlementResult) => void; onRejected: (code?: string) => void;
}) {
  const storageKey = `payment-confirm:${apiClient.getSnapshot().user?.id ?? 'session'}:${transactionId}`;
  const [command, setCommand] = useState<PaymentCommand | null>(() => recover(storageKey));
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [observedInvoiceId, setObservedInvoiceId] = useState('');
  const [result, setResult] = useState<SettlementResult | null>(null);
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onLockedChange(!!command || busy || !!result); }, [command, busy, result, onLockedChange]);
  // A different preview/input must receive a new explicit acknowledgement.
  const fingerprint = input ? JSON.stringify(input) : '';
  useEffect(() => { setAccepted(false); }, [fingerprint]);

  function keep(value: PaymentCommand | null) {
    if (mounted.current) setCommand(value);
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch {
      if (value && mounted.current) setNotice('Trình duyệt không lưu được yêu cầu. Giữ trang này mở để tra cứu hoặc gửi lại với cùng khóa.');
    }
  }
  function complete(value: SettlementResult) {
    if (value.transactionId !== transactionId || value.status !== 'SETTLED') throw new ApiError('Kết quả không khớp giao dịch. Giữ nguyên yêu cầu để đối chiếu.');
    keep(null);
    if (mounted.current) { setResult(value); setError(''); onSettled?.(value); }
  }
  async function send(next: PaymentCommand) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(''); keep(next);
    try { complete(await paymentsApi.confirm(transactionId, next.input, next.key)); }
    catch (cause) {
      if (!mounted.current) return;
      const problem = cause instanceof ApiError ? cause : new ApiError('Không kết nối được máy chủ.');
      if (problem.status !== undefined && problem.status < 500 && ![401, 403].includes(problem.status) && problem.code !== 'IDEMPOTENCY_CONFLICT') {
        keep(null); onRejected(problem.code); setAccepted(false);
        setError(problem.code === 'PAYMENT_REFERENCE_USED'
          ? 'Tham chiếu đã dùng. Kiểm tra khoản thu gốc; không tự đổi mã để vượt xung đột.' : problem.message);
      } else setError(`${problem.message} Chưa xác định kết quả hệ thống. Tra cứu hoặc gửi lại cùng yêu cầu; không thực hiện thu thêm.`);
    } finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  async function lookup() {
    if (!command || sending.current) return;
    sending.current = true; setBusy(true); setError('');
    try { complete((await paymentsApi.operation(command.key)).responseBody); }
    catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError && cause.status === 404) {
        setError('Chưa thấy kết quả theo khóa; yêu cầu có thể còn đang xử lý. Giữ nguyên khóa và dữ liệu.');
        try {
          const detail = await paymentsApi.detail(transactionId);
          if (mounted.current) {
            setNotice(`Trạng thái giao dịch hiện tại: ${detail.transaction.status}${detail.invoice ? ` · Chứng từ ${detail.invoice.invoiceNo}` : ''}.`);
            setObservedInvoiceId(detail.invoice?.id ?? '');
          }
        } catch { /* Lookup remains unresolved; retain the immutable command. */ }
      } else setError(`${paymentError(cause)} Chưa xác định kết quả; giữ nguyên yêu cầu.`);
    } finally { sending.current = false; if (mounted.current) setBusy(false); }
  }

  if (result) return onSettled ? <p role="status">Khoản thu đã được xác nhận trong hệ thống.</p> : <SettlementSummary result={result} />;
  return <section aria-label="Xác nhận khoản thu" aria-busy={busy}>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {command ? <><p>Yêu cầu xác nhận đang được kiểm tra. Dữ liệu và khóa được giữ nguyên.</p>
      <p>Đã gửi: {command.input.method === 'CASH' ? 'Tiền mặt' : 'Chuyển khoản'} · {money(command.input.amount)}</p>
      <p>Căn cứ đã gửi: {command.input.evidenceNote}</p>
      {command.input.bankReference && <p>Tham chiếu đã gửi: {command.input.bankReference} · Tài khoản: {command.input.receivingAccountCode}</p>}
      {command.input.receivedAt && <p>Báo có đã đối chiếu: {timestamp(command.input.receivedAt)}</p>}
      <p>Khóa tra cứu: {command.key}</p>
      <button type="button" disabled={busy} onClick={() => void lookup()}>Tra cứu kết quả xác nhận</button>{' '}
      <button type="button" disabled={busy} onClick={() => void send(command)}>Gửi lại cùng yêu cầu</button></>
      : input && <><label><input type="checkbox" checked={accepted} disabled={busy} onChange={event => setAccepted(event.target.checked)} />
        Tôi xác nhận đã thực nhận đủ tiền và đã đối chiếu đúng giao dịch.</label>
        <button type="button" disabled={!accepted || busy} onClick={() => {
          if (accepted && !sending.current) void send({ key: crypto.randomUUID(), input: { ...input } });
        }}>Xác nhận thu tiền</button></>}
    {busy && <p role="status">Đang xử lý xác nhận…</p>}
    {observedInvoiceId && <InvoiceDetails id={observedInvoiceId} />}
  </section>;
}
