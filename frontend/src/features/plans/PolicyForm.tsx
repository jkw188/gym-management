import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { CatalogError, catalogError } from './PlanForm';
import { findCreatedPolicy, formatVnd, plansApi, type CatalogPage, type CatalogStatus, type Plan, type PlanPolicy } from './plans.api';
import { Icon } from '../../components/Icon';

// Search/page rather than truncating the selectable catalog to its first 100 entries.
export function PlanPicker({ label, value, onChange }: { label: string; value: string; onChange: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<CatalogPage<Plan>>();
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    plansApi.list({ q, page, limit: 20 }, controller.signal).then(data => { if (!controller.signal.aborted) setResult(data); })
      .catch(failure => { if (!controller.signal.aborted) setError(catalogError(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [q, page, retry]);
  return <div><label>{`Tìm ${label.toLowerCase()}`}<input value={q} maxLength={120} onChange={e => { setQ(e.target.value); setPage(1); }} /></label>
    <label>{label}<select required value={value} disabled={loading || Boolean(error)} onChange={e => onChange(e.target.value)}><option value="">Chọn gói</option>
      {value && !result?.items.some(plan => plan.id === value) && <option value={value}>{value} (đã chọn)</option>}
      {result?.items.map(plan => <option key={plan.id} value={plan.id}>{plan.code} — {plan.kind} — {formatVnd(plan.price)} — {plan.status}</option>)}</select></label>
    {loading && <p role="status">Đang tải gói…</p>}
    {!loading && !error && result?.items.length === 0 && <p>Không tìm thấy gói.</p>}
    <CatalogError error={error} />{error && <button type="button" onClick={() => setRetry(value => value + 1)}>Thử lại {label.toLowerCase()}</button>}
    <div className="user-actions"><button type="button" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}><Icon name="prev" label={`Trang trước ${label.toLowerCase()}`} /></button>
      <span>{page} / {result?.totalPages ?? 0}</span><button type="button" disabled={loading || !result || page >= result.totalPages} onClick={() => setPage(page + 1)}><Icon name="next" label={`Trang sau ${label.toLowerCase()}`} /></button></div>
  </div>;
}

export function PolicyForm({ initial, onClose, onSaved }: { initial?: PlanPolicy; onClose: () => void; onSaved: () => void }) {
  const [policy, setPolicy] = useState(initial);
  const [from, setFrom] = useState(initial?.fromPlanId ?? '');
  const [to, setTo] = useState(initial?.toPlanId ?? '');
  const [status, setStatus] = useState<CatalogStatus>(initial?.status ?? 'INACTIVE');
  const [note, setNote] = useState(initial?.note ?? '');
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState('');
  const busy = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy.current || uncertain) return;
    busy.current = true; setPending(true); setError(null);
    try {
      if (policy) await plansApi.updatePolicy(policy.id, { version: policy.version, status, note });
      else await plansApi.createPolicy({ fromPlanId: from, toPlanId: to, status, note });
      onSaved();
    } catch (failure) {
      const next = catalogError(failure); setError(next);
      if (!policy && (!next.status || next.status >= 500 || next.code === 'POLICY_EXISTS')) setUncertain(true);
    } finally { busy.current = false; setPending(false); }
  }
  async function lookup(reload: boolean) {
    if (busy.current) return;
    busy.current = true; setPending(true);
    try {
      const found = await findCreatedPolicy(from, to);
      if (found) { setPolicy(found); setStatus(found.status); setNote(found.note ?? ''); setNotice('Đã tải chính sách hiện tại. Hãy đối chiếu trước khi sửa.'); }
      else if (reload) throw new ApiError('Không tìm thấy chính sách. Bản nhập vẫn được giữ.', 404);
      else setNotice('Chưa tìm thấy cặp chính sách. Bạn có thể gửi lại.');
      setUncertain(false); setError(null);
    } catch (failure) { setError(catalogError(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  const fieldError = (field: string) => error?.details?.filter(detail => detail.field === field).map((detail, i) => <p key={i} className="field-error">{detail.message}</p>);
  return <section aria-label="Chính sách chuyển đổi"><h3>{policy ? 'Sửa chính sách' : 'Tạo chính sách'}</h3>
    <p>Công thức cố định: PRORATED_REMAINING_DAYS_V1. Bật khi hai gói đang bán, cùng loại, giá đích cao hơn; quota PT đích không thấp hơn.</p>
    <form onSubmit={event => void submit(event)}><fieldset disabled={pending || uncertain}>
      {policy ? <p>Gói nguồn: {from} → Gói đích: {to} (không thể thay đổi)</p> : <><PlanPicker label="Gói nguồn" value={from} onChange={setFrom} />{fieldError('fromPlanId')}
        <PlanPicker label="Gói đích" value={to} onChange={setTo} />{fieldError('toPlanId')}</>}
      <label htmlFor="policy-status">Trạng thái chính sách</label><select id="policy-status" value={status} onChange={e => setStatus(e.target.value as CatalogStatus)}><option value="INACTIVE">Ngừng áp dụng</option><option value="ACTIVE">Đang áp dụng</option></select>{fieldError('status')}
      <label htmlFor="policy-note">Ghi chú</label><textarea id="policy-note" maxLength={500} value={note} onChange={e => setNote(e.target.value)} />{fieldError('note')}
    </fieldset><CatalogError error={error} />{notice && <p role="status">{notice}</p>}
      {error?.code === 'VERSION_CONFLICT' && <><p>Bản nhập được giữ. Tải lại sẽ bỏ bản nhập để lấy phiên bản mới.</p><button type="button" disabled={pending} onClick={() => void lookup(true)}>Bỏ bản nhập và tải lại chính sách</button></>}
      {uncertain && <button type="button" disabled={pending} onClick={() => void lookup(false)}>Tra cứu cặp chính sách trước khi thử lại</button>}
      <div className="user-actions"><button type="submit" disabled={pending || uncertain || error?.code === 'VERSION_CONFLICT'}>{pending ? 'Đang xử lý…' : 'Lưu chính sách'}</button>
        <button type="button" className="secondary" disabled={pending} onClick={onClose}><Icon name="close" label="Đóng" /></button></div>
    </form></section>;
}
