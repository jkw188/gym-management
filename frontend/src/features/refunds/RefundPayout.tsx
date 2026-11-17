import { useState, type FormEvent } from 'react';
import { orderDate } from '../orders/orders.api';
import { CommandRecovery, useReturnCommand } from '../returns/useReturnCommand';
import type { RefundDetail } from './refunds.api';

export function RefundPayout({ refund, onChanged }: { refund: RefundDetail; onChanged: () => Promise<void> }) {
  const [method, setMethod] = useState('CASH'), [paidOutAt, setPaidOutAt] = useState(''), [evidenceNote, setEvidenceNote] = useState('');
  const [payoutAccountCode, setAccount] = useState(''), [bankReference, setBank] = useState(''), [cashVoucherReference, setVoucher] = useState('');
  const [failureReason, setReason] = useState(''), [checked, setChecked] = useState(false);
  const state = useReturnCommand<{ id: string }>('payout', onChanged);
  const locked = Boolean(state.command) || state.pending || state.denied || refund.status === 'SUCCEEDED';
  function confirm(event: FormEvent) {
    event.preventDefault(); if (!checked || locked) return;
    state.submit({ version: refund.version ?? 0, amount: refund.amount, method, paidOutAt: new Date(`${paidOutAt}+07:00`).toISOString(), evidenceNote: evidenceNote.trim(),
      ...(method === 'CASH' ? { cashVoucherReference: cashVoucherReference.trim() } : { payoutAccountCode: payoutAccountCode.trim(), bankReference: bankReference.trim() }) }, refund.id, 'REFUND_CONFIRM');
  }
  function fail(event: FormEvent) { event.preventDefault(); if (!locked) state.submit({ version: refund.version ?? 0, evidenceNote: evidenceNote.trim(), failureReason: failureReason.trim() }, refund.id, 'REFUND_FAIL'); }
  return <section><h3>Đối soát thực chi</h3><p>Chỉ xác nhận sau khi tiền đã được trả thật và có chứng từ. Khi kết quả chuyển tiền chưa rõ, đối soát ngân hàng trước; không ghi thất bại chỉ vì timeout.</p>
    <CommandRecovery state={state} />
    <fieldset disabled={locked}><label>Bằng chứng đối soát<textarea required minLength={10} maxLength={500} value={evidenceNote} onChange={event => setEvidenceNote(event.target.value)} /></label>
      <form onSubmit={confirm}><label>Phương thức chi<select value={method} onChange={event => setMethod(event.target.value)}><option value="CASH">Tiền mặt</option><option value="TRANSFER">Chuyển khoản</option></select></label>
        <p>Số tiền phải chi đủ: {refund.amount} VND</p><label>Thời điểm thực chi (giờ Việt Nam)<input required type="datetime-local" value={paidOutAt} onChange={event => setPaidOutAt(event.target.value)} /></label>
        {method === 'CASH' ? <label>Số phiếu chi<input required maxLength={100} value={cashVoucherReference} onChange={event => setVoucher(event.target.value)} /></label> : <>
          <label>Mã tài khoản chi<input required maxLength={40} value={payoutAccountCode} onChange={event => setAccount(event.target.value)} /></label>
          <label>Mã giao dịch ngân hàng<input required maxLength={100} value={bankReference} onChange={event => setBank(event.target.value)} /></label></>}
        <label><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />Đã xác minh tiền được trả thật, chứng từ chưa dùng khoản khác</label>
        <button disabled={!checked || evidenceNote.trim().length < 10}>Xác nhận đã hoàn tiền</button></form>
      <form onSubmit={fail}><label>Lý do xác minh chưa chi thành công<textarea required minLength={10} maxLength={500} value={failureReason} onChange={event => setReason(event.target.value)} /></label>
        <button disabled={evidenceNote.trim().length < 10}>Ghi nhận chi chưa thành công</button></form></fieldset>
    {refund.payoutEvidence && <p>Chứng từ thực chi: {refund.payoutEvidence.cashVoucherReference ?? refund.payoutEvidence.bankReference} · {refund.payoutEvidence.evidenceNote}</p>}
    {refund.attempts?.map(attempt => <p key={attempt.id}>{orderDate(attempt.occurredAt)} · {attempt.statusBefore} → {attempt.statusAfter} · {attempt.evidenceNote} {attempt.failureReason}</p>)}
  </section>;
}
