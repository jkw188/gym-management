import { useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { findCreatedPlan, plansApi, type CatalogStatus, type Plan, type PlanInput } from './plans.api';

export function CatalogError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return <div role="alert" className="form-error"><p>{error.message}</p>
    {error.details?.map((detail, i) => <p key={i}>{detail.field}: {detail.message}</p>)}
    {error.requestId && <small>Mã tra cứu: {error.requestId}</small>}</div>;
}
export const catalogError = (error: unknown) => error instanceof ApiError ? error : new ApiError('Không thể kết nối máy chủ. Hãy kiểm tra lại kết quả trước khi thử lại.');

export function PlanForm({ initial, onClose, onSaved }: { initial?: Plan; onClose: () => void; onSaved: () => void }) {
  const [plan, setPlan] = useState(initial);
  const [draft, setDraft] = useState<PlanInput>(initial ?? { code: '', name: '', kind: 'GYM', durationDays: 30, sessionsQuota: 0, price: '', benefits: '' });
  const [status, setStatus] = useState<CatalogStatus>(initial?.status ?? 'ACTIVE');
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState('');
  const busy = useRef(false);
  const fields = Object.fromEntries((error?.details ?? []).map(detail => [detail.field, detail.message]));
  const change = <K extends keyof PlanInput>(key: K, value: PlanInput[K]) => setDraft(current => ({ ...current, [key]: value }));
  const fieldError = (field: string) => fields[field] && <p className="field-error" id={`plan-${field}-error`}>{fields[field]}</p>;
  const fieldProps = (field: string) => ({ 'aria-invalid': Boolean(fields[field]), 'aria-describedby': fields[field] ? `plan-${field}-error` : undefined });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || uncertain) return;
    busy.current = true; setPending(true); setError(null); setNotice('');
    try {
      if (plan) {
        const { code: _code, kind: _kind, ...mutable } = draft;
        await plansApi.update(plan.id, { ...mutable, status, version: plan.version });
      } else await plansApi.create(draft);
      onSaved();
    } catch (failure) {
      const next = catalogError(failure); setError(next);
      if (!plan && (!next.status || next.status >= 500 || next.code === 'PLAN_CODE_EXISTS')) setUncertain(true);
    } finally { busy.current = false; setPending(false); }
  }
  async function reload() {
    if (!plan || busy.current) return;
    busy.current = true; setPending(true);
    try { const fresh = await plansApi.detail(plan.id); setPlan(fresh); setDraft(fresh); setStatus(fresh.status); setError(null); }
    catch (failure) { setError(catalogError(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  async function lookup() {
    if (busy.current) return;
    busy.current = true; setPending(true);
    try {
      const found = await findCreatedPlan(draft.code);
      if (found) { setPlan(found); setDraft(found); setStatus(found.status); setNotice('Đã tìm thấy mã gói. Hãy đối chiếu dữ liệu trước khi chỉnh sửa.'); }
      else setNotice('Chưa tìm thấy mã gói. Bạn có thể gửi lại sau khi kiểm tra dữ liệu.');
      setUncertain(false); setError(null);
    } catch (failure) { setError(catalogError(failure)); }
    finally { busy.current = false; setPending(false); }
  }
  return <section aria-label={plan ? 'Sửa gói' : 'Tạo gói'}><h3>{plan ? `Sửa gói ${plan.code}` : 'Tạo gói'}</h3>
    <p>Thay đổi chỉ áp dụng cho lần bán mới; giao dịch đã tạo giữ nguyên điều khoản.</p>
    <form onSubmit={event => void submit(event)}><fieldset disabled={pending || uncertain}>
      <label htmlFor="plan-code">Mã gói</label><input id="plan-code" value={draft.code} disabled={Boolean(plan)} required minLength={3} maxLength={30} {...fieldProps('code')} onChange={e => change('code', e.target.value.toUpperCase())} />{fieldError('code')}
      <label htmlFor="plan-name">Tên gói</label><input id="plan-name" value={draft.name} required minLength={2} maxLength={120} {...fieldProps('name')} onChange={e => change('name', e.target.value)} />{fieldError('name')}
      <label htmlFor="plan-kind">Loại gói</label><select id="plan-kind" value={draft.kind} disabled={Boolean(plan)} onChange={e => setDraft(current => ({ ...current, kind: e.target.value as Plan['kind'], sessionsQuota: e.target.value === 'GYM' ? 0 : 1 }))}>
        <option value="GYM">GYM</option><option value="PT">PT</option></select>
      <label htmlFor="plan-duration">Thời hạn (ngày)</label><input id="plan-duration" type="number" min={1} max={3650} step={1} required value={draft.durationDays} {...fieldProps('durationDays')} onChange={e => change('durationDays', e.target.valueAsNumber)} />{fieldError('durationDays')}
      {draft.kind === 'PT' ? <><label htmlFor="plan-quota">Số buổi PT</label><input id="plan-quota" type="number" min={1} max={10000} step={1} required value={draft.sessionsQuota} {...fieldProps('sessionsQuota')} onChange={e => change('sessionsQuota', e.target.valueAsNumber)} />{fieldError('sessionsQuota')}</> : <p>GYM: quota 0 buổi.</p>}
      <label htmlFor="plan-price">Giá (VND)</label><input id="plan-price" inputMode="numeric" pattern="0*[0-9]{1,12}" required value={draft.price} {...fieldProps('price')} onChange={e => change('price', e.target.value)} />{fieldError('price')}
      <label htmlFor="plan-benefits">Quyền lợi</label><textarea id="plan-benefits" required maxLength={1000} value={draft.benefits} {...fieldProps('benefits')} onChange={e => change('benefits', e.target.value)} />{fieldError('benefits')}
      {plan && <><label htmlFor="plan-status">Trạng thái gói</label><select id="plan-status" value={status} onChange={e => setStatus(e.target.value as CatalogStatus)}><option value="ACTIVE">Đang bán</option><option value="INACTIVE">Ngừng bán</option></select></>}
    </fieldset><CatalogError error={error} />
      {notice && <p role="status">{notice}</p>}
      {error?.code === 'VERSION_CONFLICT' && <p>Bản nhập đang được giữ. Tải lại sẽ bỏ bản nhập và lấy dữ liệu mới.</p>}
      {error?.code === 'VERSION_CONFLICT' && <button type="button" disabled={pending} onClick={() => void reload()}>Bỏ bản nhập và tải lại gói</button>}
      {uncertain && <button type="button" disabled={pending} onClick={() => void lookup()}>Tra cứu mã gói trước khi thử lại</button>}
      <div className="user-actions"><button type="submit" disabled={pending || uncertain || error?.code === 'VERSION_CONFLICT'}>{pending ? 'Đang xử lý…' : 'Lưu gói'}</button>
        <button type="button" className="secondary" disabled={pending} onClick={onClose}>Đóng</button></div>
    </form></section>;
}
