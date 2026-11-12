import { useEffect, useRef, useState } from 'react';
import { apiClient, ApiError } from '../../api/client';
import { vietnamDate } from '../shifts/shift-time';
import { salesApi, type PendingSales, type SaleDetail, type SaleInput, type SalePlan, type SalePreview } from './sales.api';

type Command = { type: 'create'; key: string; input: SaleInput } |
  { type: 'cancel'; key: string; saleId: string; input: { version: number; reason: string } };
const errorOf = (cause: unknown) => cause instanceof ApiError ? cause : new ApiError('Không thể xử lý đăng ký gói.');
const blockingText: Record<string, string> = {
  CURRENT_SERVICE_EXISTS: 'Hội viên đã có gói cùng loại còn hạn hoặc chờ hiệu lực.',
  PENDING_SALE_EXISTS: 'Hội viên có giao dịch chờ cùng loại. Hãy mở và xử lý giao dịch chờ.',
};

function recoverCommand(storageKey: string, memberId: string): Command | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Command | null;
    if (!value || typeof value.key !== 'string' || !value.input) return null;
    if (value.type === 'create' && value.input.memberId === memberId && typeof value.input.planId === 'string' &&
      Number.isSafeInteger(value.input.planVersion) && typeof value.input.startDate === 'string') return value;
    if (value.type === 'cancel' && typeof value.saleId === 'string' && Number.isSafeInteger(value.input.version) &&
      typeof value.input.reason === 'string') return value;
  } catch { /* Storage unavailable or corrupt: the in-memory key still protects this mounted flow. */ }
  return null;
}

export function ServiceSalePanel({ memberId }: { memberId: string }) {
  const [open, setOpen] = useState(false);
  return <section><h3>Đăng ký gói tại quầy</h3>
    <button type="button" onClick={() => setOpen(true)} disabled={open}>Đăng ký gói</button>
    {open && <SaleWizard key={memberId} memberId={memberId} />}
  </section>;
}

function SaleWizard({ memberId }: { memberId: string }) {
  const storageKey = `service-sale:${apiClient.getSnapshot().user?.id ?? 'session'}:${memberId}`;
  const [plans, setPlans] = useState<SalePlan[]>([]);
  const [pendingSales, setPendingSales] = useState<PendingSales | null>(null);
  const [planId, setPlanId] = useState('');
  const [startDate, setStartDate] = useState(() => vietnamDate(new Date()));
  const [preview, setPreview] = useState<SalePreview | null>(null);
  const [result, setResult] = useState<SaleDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [command, setCommand] = useState<Command | null>(() => recoverCommand(storageKey, memberId));
  const [reason, setReason] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const sending = useRef(false);
  const mounted = useRef(true);
  const selection = useRef(0);
  const plan = plans.find(item => item.id === planId);

  function keepCommand(value: Command | null) {
    setCommand(value);
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch { /* Browsers may disable storage; retain the command in memory. */ }
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [memberId]);

  async function run(work: () => Promise<void>) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try { await work(); }
    catch (cause) { if (mounted.current) setError(errorOf(cause)); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  async function load() {
    await run(async () => {
      const results = await Promise.all([salesApi.catalog(), salesApi.pending(memberId)]);
      if (mounted.current) { setPlans(results[0].items); setPendingSales(results[1]); setPreview(null); }
    });
  }
  function changeSelection() { selection.current++; setPreview(null); setError(null); }
  async function previewSale() {
    if (!plan || command) return;
    const round = selection.current;
    await run(async () => {
      const response = await salesApi.preview({ memberId, planId: plan.id, planVersion: plan.planVersion, startDate });
      if (mounted.current && round === selection.current) { setPreview(response); setResult(null); }
    });
  }
  async function send(next: Command) {
    // Keep the immutable input AND key until the server returns a definitive outcome.
    keepCommand(next);
    await run(async () => {
      try {
        if (next.type === 'create') {
          const response = await salesApi.create(next.input, next.key);
          if (mounted.current) { setResult(response); setPreview(null); }
        } else {
          await salesApi.cancel(next.saleId, next.input, next.key);
          // The command is committed even if the following read fails.
          if (mounted.current) {
            setResult(current => current && current.saleId === next.saleId ? { ...current, transactionStatus: 'CANCELLED', cancelReason: next.input.reason } : current);
            setConfirmCancel(false); setReason('');
          }
        }
        keepCommand(null);
      } catch (cause) {
        const problem = errorOf(cause);
        if (problem.status !== undefined && problem.status < 500) {
          keepCommand(null);
          if (mounted.current) { setPreview(null); setConfirmCancel(false); }
        }
        throw problem;
      }
      const list = await salesApi.pending(memberId);
      if (mounted.current) setPendingSales(list);
    });
  }
  async function openSale(id: string) {
    if (command) return;
    await run(async () => {
      const response = await salesApi.detail(id);
      if (mounted.current) { setResult(response); setPreview(null); setConfirmCancel(false); setReason(''); }
    });
  }

  return <div aria-busy={busy}>
    {busy && <p role="status">Đang xử lý đăng ký gói…</p>}
    {error && <div role="alert"><p>{blockingText[error.code ?? ''] ?? error.message}</p>
      {error.requestId && <small>Mã tra cứu: {error.requestId}</small>}
      {error.code === 'PLAN_CHANGED' && <p>Điều khoản đã đổi. Tải lại danh mục và xem trước lần nữa.</p>}
      {error.code === 'VERSION_CONFLICT' && <p>Giao dịch đã đổi. Tải lại giao dịch trước khi thao tác tiếp.</p>}
    </div>}
    {command && !busy && <div><p>Chưa xác định kết quả. Giữ nguyên yêu cầu để tránh tạo giao dịch trùng.</p>
      <button type="button" onClick={() => void send(command)}>Kiểm tra / gửi lại cùng yêu cầu</button></div>}
    <button type="button" disabled={busy || !!command} onClick={() => void load()}>Tải lại danh mục và giao dịch chờ</button>
    <fieldset disabled={busy || !!command}><legend>Điều khoản đăng ký</legend>
      <label htmlFor="sale-plan">Gói đang bán</label>
      <select id="sale-plan" value={planId} onChange={event => { changeSelection(); setPlanId(event.target.value); }}>
        <option value="">Chọn gói</option>{plans.map(item => <option key={item.id} value={item.id}>{item.name} ({item.kind})</option>)}
      </select>
      {!plans.length && !busy && <p>Chưa có gói ACTIVE để bán.</p>}
      {plan && <><p>Giá: {plan.price} VND · Thời hạn: {plan.durationDays} ngày · Quota: {plan.sessions} buổi</p><p>Quyền lợi: {plan.benefits}</p></>}
      <label htmlFor="sale-start">Ngày bắt đầu yêu cầu (Việt Nam)</label>
      <input id="sale-start" type="date" min={vietnamDate(new Date())} value={startDate}
        onChange={event => { changeSelection(); setStartDate(event.target.value); }} />
      <button type="button" disabled={!plan || !startDate} onClick={() => void previewSale()}>Xem trước đăng ký</button>
    </fieldset>
    {preview && <div><p>Kỳ dự kiến: {preview.requestedStartDate} → {preview.expectedEndDate} · Cần thu: {preview.amountDue} VND</p>
      {!preview.canProceed && <p role="alert">{blockingText[preview.blockingCode ?? ''] ?? 'Không thể đăng ký gói này.'}</p>}
      {preview.amountDue === '0' && <p>Miễn phí theo giá 0 của gói đã xác nhận. Hệ thống cấp gói và chứng từ, không tạo khoản thu 0.</p>}
      <button type="button" disabled={!preview.canProceed || busy || !!command || !plan} onClick={() => {
        if (!plan || sending.current) return;
        void send({ type: 'create', key: crypto.randomUUID(), input: { memberId, planId: plan.id, planVersion: preview.planVersion, startDate } });
      }}>Xác nhận tạo đăng ký</button>
    </div>}
    {result && <section aria-label="Kết quả đăng ký"><h4>{result.transactionCode}</h4><p>{result.planName} · {result.amountDue} VND</p>
      <p>Quyền lợi đã chốt: {result.benefits} · Quota: {result.sessions} buổi</p>
      {result.transactionStatus === 'PENDING' && <><p>Chờ thu tiền — chưa cấp gói.</p>
        <p>Kỳ dự kiến: {result.startDate} → {result.endDate}. Kỳ thực tế được xác định khi hoàn tất thu.</p>
        <p>Chức năng xác nhận thu tiền chưa sẵn sàng. Giao dịch được lưu để xử lý tiếp.</p>
        <button type="button" disabled={busy || !!command} onClick={() => setConfirmCancel(true)}>Hủy đăng ký chờ</button></>}
      {result.transactionStatus === 'SETTLED' && <><p>Đã hoàn tất. Kỳ thực tế: {result.startDate} → {result.endDate} (bao gồm ngày cuối).</p>
        <p>Ngày yêu cầu: {result.requestedStartDate} · Mã membership: {result.membershipId}</p>
        <p>Chứng từ: {result.invoiceNumber ?? result.invoiceId}</p>
        <p>{result.notificationState === 'NO_LINKED_ACCOUNT' ? 'Thông báo đã lưu; hội viên chưa có tài khoản nhận.' : 'Thông báo đã được lưu.'}</p></>}
      {result.transactionStatus === 'CANCELLED' && <p>Đã hủy đăng ký chờ. Lý do: {result.cancelReason}</p>}
      <button type="button" disabled={busy || !!command} onClick={() => void openSale(result.saleId)}>Tải lại giao dịch</button>
      {confirmCancel && result.transactionStatus === 'PENDING' && <div role="dialog" aria-modal="true" aria-label="Xác nhận hủy đăng ký">
        <label htmlFor="sale-cancel-reason">Lý do hủy (10–500 ký tự)</label>
        <textarea id="sale-cancel-reason" disabled={busy || !!command} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} />
        <button type="button" disabled={busy || !!command || reason.trim().length < 10} onClick={() => {
          if (sending.current) return;
          void send({ type: 'cancel', key: crypto.randomUUID(), saleId: result.saleId,
            input: { version: result.transactionVersion, reason: reason.trim() } });
        }}>Xác nhận hủy</button>
        <button type="button" disabled={busy || !!command} onClick={() => setConfirmCancel(false)}>Giữ đăng ký</button>
      </div>}
    </section>}
    {pendingSales && <section><h4>Đăng ký chờ xử lý ({pendingSales.total})</h4>
      {!pendingSales.items.length && <p>Không có đăng ký chờ.</p>}
      <ul>{pendingSales.items.map(item => <li key={item.saleId}>{item.transactionCode} ({item.kind}){' '}
        <button type="button" disabled={busy || !!command} onClick={() => void openSale(item.saleId)}>Mở đăng ký chờ</button></li>)}</ul>
    </section>}
  </div>;
}
