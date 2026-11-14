import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient, ApiError } from '../../api/client';
import type { MemberMembership } from '../members/members.api';
import { renewalsApi, type RenewalInput, type RenewalPreview } from './renewals.api';
import { salesApi, type SaleDetail, type SalePlan } from './sales.api';

interface Command { key: string; input: RenewalInput }
const problemOf = (failure: unknown) => failure instanceof ApiError ? failure : new ApiError('Không thể xử lý gia hạn.');
const messages: Record<string, string> = {
  SOURCE_NOT_LATEST: 'Kỳ nguồn không còn mới nhất. Tải lại lịch sử và tự chọn lại kỳ, sau đó xem trước và xác nhận.',
  SOURCE_NOT_ELIGIBLE: 'Kỳ nguồn không đủ điều kiện gia hạn. Tải lại lịch sử và xác nhận lại lựa chọn.',
  PLAN_CHANGED: 'Điều khoản gói đã đổi. Tải lại điều khoản và xem trước lần nữa.',
  PLAN_NOT_AVAILABLE: 'Gói nguồn ngừng bán hoặc không còn phù hợp để gia hạn.',
  PENDING_SALE_EXISTS: 'Đã có giao dịch chờ cùng loại. Mở giao dịch chờ ở mục đăng ký gói để xử lý.',
};
function recover(key: string, memberId: string): Command | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Command | null;
    if (value && /^[0-9a-f-]{36}$/i.test(value.key) && value.input?.memberId === memberId &&
      /^[0-9a-f]{24}$/i.test(value.input.previousSaleId) && Number.isSafeInteger(value.input.planVersion) && value.input.planVersion >= 0) return value;
  } catch { /* Retain the in-memory command when storage is unavailable. */ }
  return null;
}

export function ServiceRenewalPanel({ memberId, source, onLockedChange, onRefresh }: {
  memberId: string; source: MemberMembership | null; onLockedChange: (locked: boolean) => void; onRefresh: () => void;
}) {
  const storageKey = `service-renewal:${apiClient.getSnapshot().user?.id ?? 'session'}:${memberId}`;
  const [command, setCommand] = useState<Command | null>(() => recover(storageKey, memberId));
  const [plan, setPlan] = useState<SalePlan | null>(null);
  const [preview, setPreview] = useState<RenewalPreview | null>(null);
  const [result, setResult] = useState<SaleDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [stale, setStale] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  const sending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onLockedChange(busy || !!command); }, [busy, command, onLockedChange]);
  useEffect(() => {
    if (!source || command) return;
    let active = true;
    setPlan(null); setPreview(null); setResult(null); setError(null); setStale(false); setBusy(true);
    void Promise.all([salesApi.detail(source.saleId), salesApi.catalog()]).then(([sale, catalog]) => {
      if (!active) return;
      const current = catalog.items.find(item => item.id === sale.planId && item.kind === source.kind);
      if (!current) throw new ApiError(messages.PLAN_NOT_AVAILABLE, 409, undefined, undefined, undefined, 'PLAN_NOT_AVAILABLE');
      setPlan(current);
    }).catch(failure => { if (active) setError(problemOf(failure)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
    // Clearing an uncertain command must not erase its committed result or start another request.
  }, [source?.saleId, reload]);

  function keep(value: Command | null) {
    setCommand(value);
    try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); }
    catch { setStorageWarning(true); }
  }
  async function run(work: () => Promise<void>) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try { await work(); }
    catch (failure) { if (alive.current) setError(problemOf(failure)); }
    finally { sending.current = false; if (alive.current) setBusy(false); }
  }
  async function review() {
    if (!source || !plan || command || stale) return;
    await run(async () => {
      setPreview(null);
      try {
        const next = await renewalsApi.preview({ memberId, previousSaleId: source.saleId, planVersion: plan.planVersion });
        if (alive.current) setPreview(next);
      } catch (failure) {
        if (alive.current && problemOf(failure).status === 409) setStale(true);
        throw failure;
      }
    });
  }
  function accepted(value: SaleDetail) {
    keep(null);
    if (alive.current) { setResult(value); setPreview(null); onRefresh(); }
  }
  async function send(next: Command) {
    if (sending.current) return;
    keep(next);
    await run(async () => {
      try { accepted(await renewalsApi.create(next.input, next.key)); }
      catch (failure) {
        const problem = problemOf(failure);
        // 401/403/conflict or transport/server failures may obscure a committed command: preserve its key.
        if (problem.status === 400 || problem.status === 404 || problem.status === 409 && problem.code !== 'IDEMPOTENCY_CONFLICT') {
          keep(null);
          if (alive.current) { setPreview(null); setStale(true); }
        }
        throw failure;
      }
    });
  }
  async function lookup() {
    if (!command) return;
    await run(async () => {
      try { accepted((await renewalsApi.operation(command.key)).responseBody); }
      catch (failure) {
        if (problemOf(failure).status === 404) throw new ApiError('Chưa thấy kết quả; yêu cầu có thể vẫn đang xử lý. Giữ nguyên khóa, chỉ gửi lại cùng yêu cầu.');
        throw failure;
      }
    });
  }
  async function refreshResult() {
    if (!result || command) return;
    await run(async () => {
      const next = await salesApi.detail(result.saleId);
      if (alive.current) { setResult(next); onRefresh(); }
    });
  }

  if (!source && !command && !result) return null;
  return <section aria-label="Gia hạn kỳ gói" aria-busy={busy}><h4>Gia hạn gói tại quầy</h4>
    {source && <p>Kỳ nguồn: {source.planName} ({source.kind}) · Hết hạn {source.endDate} · Mã lần bán {source.saleId}</p>}
    {busy && <p role="status">Đang xử lý gia hạn…</p>}
    {error && <div role="alert"><p>{messages[error.code ?? ''] ?? error.message}</p>{error.requestId && <small>Mã tra cứu: {error.requestId}</small>}</div>}
    {storageWarning && <p role="alert">Trình duyệt không lưu được khóa khôi phục. Giữ trang này mở đến khi xác định kết quả.</p>}
    {command && <div><p>Chưa xác định kết quả gia hạn. Không tạo yêu cầu hoặc khóa mới.</p>
      <button type="button" disabled={busy} onClick={() => void lookup()}>Tra cứu kết quả gia hạn</button>
      <button type="button" disabled={busy} onClick={() => void send(command)}>Gửi lại cùng yêu cầu gia hạn</button></div>}
    {!command && !result && <>
      <button type="button" disabled={busy} onClick={() => { setPreview(null); setReload(value => value + 1); onRefresh(); }}>Tải lại điều khoản và lịch sử</button>
      {plan && <><p>Điều khoản kỳ mới: {plan.price} VND · {plan.durationDays} ngày · Quota riêng {plan.sessions} buổi</p>
        <p>Quyền lợi kỳ mới: {plan.benefits}</p>
        <button type="button" disabled={busy || stale} onClick={() => void review()}>Xem trước gia hạn</button></>}
      {preview && <div><p>Ngày hết nguồn: {preview.sourceEndDate}</p>
        <p>Kỳ dự kiến: {preview.expectedStartDate} → {preview.expectedEndDate} · Cần thu {preview.amountDue} VND</p>
        <p>Đây là ngày dự kiến. Ngày thực tế được tính lại khi hoàn tất; chờ thu không kéo dài quyền kỳ cũ.</p>
        {preview.blockingCode && <p role="alert">{messages[preview.blockingCode] ?? 'Chưa thể gia hạn.'}</p>}
        {preview.amountDue === '0' && <p>Nghĩa vụ miễn phí: cấp kỳ mới và chứng từ 0 đồng, không nhập khoản thu 0.</p>}
        <button type="button" disabled={busy || !preview.canProceed || stale} onClick={() => {
          if (!sending.current) void send({ key: crypto.randomUUID(), input: { memberId, previousSaleId: preview.previousSaleId, planVersion: preview.planVersion } });
        }}>Xác nhận tạo gia hạn</button></div>}
    </>}
    {result && <div><h5>{result.transactionCode}</h5><p>{result.planName} · {result.amountDue} VND</p>
      <p>Quyền lợi kỳ mới: {result.benefits} · Quota riêng {result.sessions} buổi</p>
      {result.transactionStatus === 'PENDING' && <><p>Gia hạn đang chờ thu — chưa cấp kỳ mới, kỳ cũ giữ nguyên.</p>
        <p>Kỳ dự kiến: {result.startDate} → {result.endDate}</p>
        <p>Tìm mã {result.transactionCode} tại trang đối chiếu để thu hoặc mở giao dịch chờ ở mục đăng ký gói để hủy.</p>
        <Link to={`/${apiClient.getSnapshot().user?.roleCode === 'ADMIN' ? 'admin' : 'staff'}/transactions`}>Đối chiếu và thu gia hạn</Link></>}
      {result.transactionStatus === 'SETTLED' && <><p>Đã cấp kỳ gia hạn riêng: {result.startDate} → {result.endDate}</p>
        <p>Kỳ nguồn giữ nguyên lịch sử. Mã membership mới: {result.membershipId}</p><p>Chứng từ: {result.invoiceNumber ?? result.invoiceId}</p></>}
      {result.transactionStatus === 'CANCELLED' && <p>Gia hạn đã hủy; kỳ nguồn giữ nguyên.</p>}
      <button type="button" disabled={busy || !!command} onClick={() => void refreshResult()}>Tải kết quả sau thanh toán</button>
    </div>}
  </section>;
}
