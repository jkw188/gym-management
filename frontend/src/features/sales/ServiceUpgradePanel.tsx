import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, apiClient } from '../../api/client';
import type { MemberMembership } from '../members/members.api';
import { salesApi, type SaleDetail } from './sales.api';
import { upgradesApi, type UpgradeInput, type UpgradePreview, type UpgradeQuote, type UpgradeTargets } from './upgrades.api';

interface Command { key: string; input: UpgradeInput }
const failureOf = (error: unknown) => error instanceof ApiError ? error : new ApiError('Không thể xử lý nâng cấp.');
const guidance: Record<string, string> = {
  SOURCE_CHANGED: 'Kỳ nguồn đã thay đổi. Tải lại và xem trước để xác nhận mới.',
  SOURCE_NOT_CURRENT: 'Kỳ nguồn không còn hiện hành. Tải lại lịch sử và tự chọn lại kỳ.',
  FUTURE_PERIOD_EXISTS: 'Đã có kỳ tương lai cùng loại. Không thể nâng cấp làm đứt chuỗi kỳ đã mua.',
  PLAN_CHANGED: 'Gói đích đã thay đổi. Tải lại và xem trước giá mới trước khi xác nhận.',
  POLICY_CHANGED: 'Chính sách đã thay đổi. Tải lại và xem trước trước khi xác nhận.',
  QUOTE_EXPIRED: 'Đề nghị đã hết hạn. Hủy giao dịch PENDING với lý do rồi báo giá mới; không sửa hoặc thu thêm vào đề nghị cũ.',
  QUOTA_INSUFFICIENT: 'Quota đích không đủ số buổi đã dùng và đang đặt.',
  BOOKING_CONFLICT: 'Có buổi BOOKED đang bắt đầu hoặc không nằm trong kỳ đích. Không tự chuyển giờ hoặc hủy buổi.',
  PENDING_SALE_EXISTS: 'Đã có giao dịch chờ cùng loại. Xử lý giao dịch chờ trước khi tạo đề nghị mới.',
};
function restore(storageKey: string, memberId: string): Command | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Command | null;
    if (value && /^[0-9a-f-]{36}$/i.test(value.key) && value.input?.memberId === memberId &&
      /^[0-9a-f]{24}$/i.test(value.input.sourceMembershipId) && /^[0-9a-f]{24}$/i.test(value.input.targetPlanId) &&
      [value.input.sourceVersion, value.input.targetPlanVersion, value.input.policyVersion].every(n => Number.isSafeInteger(n) && n >= 0)) return value;
  } catch { /* Keep the in-memory command if browser storage is unavailable. */ }
  return null;
}
function QuoteDetails({ quote }: { quote: UpgradeQuote }) {
  return <div><p>Giá trị nguồn: {quote.baseValue} VND · Còn {quote.remainingDays}/{quote.totalDays} ngày, gồm ngày nâng cấp.</p>
    <p>Khấu trừ tính được: {quote.rawCredit} VND · Áp dụng: {quote.appliedCredit} VND</p>
    <p>Giá niêm yết đích: {quote.targetListPrice} VND · Phải thu: {quote.amountDue} VND</p>
    <p>Phần dư không hoàn: {quote.excessCredit} VND — không tạo ví, số dư hoặc dùng cho lần sau.</p>
    <p>Báo giá ngày {quote.asOfDate}; hết hạn {new Date(quote.quoteExpiresAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} (Việt Nam).</p>
    <p>Buổi đã dùng: {quote.quotaSummary.used} · BOOKED: {quote.quotaSummary.reserved} · Quota đích: {quote.quotaSummary.targetSessions}</p></div>;
}
export function ServiceUpgradePanel({ memberId, source, onLockedChange, onRefresh }: {
  memberId: string; source: MemberMembership | null; onLockedChange: (locked: boolean) => void; onRefresh: () => void;
}) {
  const storageKey = `service-upgrade:${apiClient.getSnapshot().user?.id ?? 'session'}:${memberId}`;
  const [command, setCommand] = useState<Command | null>(() => restore(storageKey, memberId));
  const [targets, setTargets] = useState<UpgradeTargets | null>(null);
  const [targetId, setTargetId] = useState('');
  const [preview, setPreview] = useState<UpgradePreview | null>(null);
  const [result, setResult] = useState<SaleDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false), [stale, setStale] = useState(false), [reload, setReload] = useState(0);
  const [storageWarning, setStorageWarning] = useState(false), [now, setNow] = useState(Date.now);
  const alive = useRef(true), sending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onLockedChange(busy || !!command); }, [busy, command, onLockedChange]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!source || command) return;
    let active = true;
    setBusy(true); setTargets(null); setTargetId(''); setPreview(null); setResult(null); setError(null); setStale(false);
    void upgradesApi.targets(memberId, source.membershipId).then(value => { if (active) setTargets(value); })
      .catch(cause => { if (active) setError(failureOf(cause)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
    // Resolving an uncertain command does not auto-reload or erase its committed result.
  }, [source?.membershipId, reload]);
  const target = targets?.items.find(item => item.planId === targetId);
  const expired = !!preview && now >= Date.parse(preview.quoteExpiresAt);
  function keep(value: Command | null) {
    setCommand(value);
    try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); }
    catch { setStorageWarning(true); }
  }
  async function run(work: () => Promise<void>) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try { await work(); } catch (cause) { if (alive.current) setError(failureOf(cause)); }
    finally { sending.current = false; if (alive.current) setBusy(false); }
  }
  function accepted(value: SaleDetail) {
    keep(null); if (alive.current) { setResult(value); setPreview(null); onRefresh(); }
  }
  async function review() {
    if (!targets || !target || !source || command || stale) return;
    await run(async () => {
      setPreview(null);
      try {
        const value = await upgradesApi.preview({ memberId, sourceMembershipId: targets.source.membershipId, sourceVersion: targets.source.version,
          targetPlanId: target.planId, targetPlanVersion: target.planVersion, policyVersion: target.policyVersion });
        if (alive.current) { setNow(Date.now()); setPreview(value); }
      } catch (cause) { if (alive.current && failureOf(cause).status === 409) setStale(true); throw cause; }
    });
  }
  async function send(next: Command) {
    if (sending.current) return;
    keep(next);
    await run(async () => {
      try { accepted(await upgradesApi.create(next.input, next.key)); }
      catch (cause) {
        const issue = failureOf(cause);
        if ([400, 404].includes(issue.status ?? 0) || issue.status === 409 && issue.code !== 'IDEMPOTENCY_CONFLICT') {
          keep(null); if (alive.current) { setPreview(null); setStale(true); }
        }
        throw cause;
      }
    });
  }
  async function lookup() {
    if (!command) return;
    await run(async () => {
      try { accepted((await upgradesApi.operation(command.key)).responseBody); }
      catch (cause) { if (failureOf(cause).status === 404) throw new ApiError('Chưa thấy kết quả; yêu cầu có thể vẫn đang xử lý. Giữ nguyên khóa, không chuyển gói lần nữa.'); throw cause; }
    });
  }
  if (!source && !command && !result) return null;
  return <section aria-label="Nâng cấp kỳ gói" aria-busy={busy}><h4>Nâng cấp gói tại quầy</h4>
    {busy && <p role="status">Đang xử lý nâng cấp…</p>}
    {error && <div role="alert"><p>{guidance[error.code ?? ''] ?? error.message}</p>{error.requestId && <small>Mã tra cứu: {error.requestId}</small>}</div>}
    {storageWarning && <p role="alert">Không lưu được khóa khôi phục. Giữ trang này mở đến khi xác định kết quả.</p>}
    {command && <div><p>Chưa xác định kết quả. Giữ nguyên yêu cầu và khóa nâng cấp.</p>
      <button disabled={busy} type="button" onClick={() => void lookup()}>Tra cứu kết quả nâng cấp</button>
      <button disabled={busy} type="button" onClick={() => void send(command)}>Gửi lại cùng yêu cầu nâng cấp</button></div>}
    {!command && !result && <><button disabled={busy} type="button" onClick={() => { setPreview(null); setReload(n => n + 1); onRefresh(); }}>Tải lại nguồn và chính sách</button>
      {targets && <><p>Gói cũ: {targets.source.planName} · {targets.source.startDate} → {targets.source.endDate}</p>
        <p>Quyền lợi cũ: {targets.source.benefits} · Đã dùng {targets.source.sessionsUsed}/{targets.source.sessionsQuota} buổi</p>
        {!targets.items.length && <p>Không có cạnh chuyển đổi ACTIVE phù hợp.</p>}
        <label htmlFor="upgrade-target">Gói nâng cấp theo chính sách</label>
        <select id="upgrade-target" disabled={busy || stale} value={targetId} onChange={event => { setTargetId(event.target.value); setPreview(null); }}>
          <option value="">Chọn gói đích</option>{targets.items.map(item => <option key={item.planId} value={item.planId}>{item.name}</option>)}
        </select>
        {target && <p>Gói mới: {target.price} VND · {target.durationDays} ngày · {target.sessions} buổi · {target.benefits}</p>}
        <button type="button" disabled={busy || stale || !target} onClick={() => void review()}>Xem trước nâng cấp</button></>}
      {preview && <div><QuoteDetails quote={preview} />
        <p>Chờ thu không đổi gói cũ hoặc chuyển BOOKED. Khi hoàn tất, gói cũ được thay thế và giữ lịch sử.</p>
        {preview.blockingCode && <p role="alert">{guidance[preview.blockingCode] ?? preview.blockingCode}</p>}
        {expired && <p role="alert">Báo giá xem trước đã hết hạn. Tải lại và xem trước để xác nhận mới.</p>}
        {preview.amountDue === '0' && <p>Không phải thu thêm: chứng từ 0 đồng và chuyển gói ngay; không tạo khoản thu 0 hoặc hoàn phần dư.</p>}
        <button type="button" disabled={busy || stale || !preview.canProceed || expired} onClick={() => {
          if (!sending.current && Date.now() < Date.parse(preview.quoteExpiresAt)) void send({ key: crypto.randomUUID(), input: { memberId,
            sourceMembershipId: preview.sourceMembershipId, sourceVersion: preview.sourceVersion, targetPlanId: preview.targetPlanId,
            targetPlanVersion: preview.targetPlanVersion, policyVersion: preview.policyVersion } });
        }}>Xác nhận tạo nâng cấp</button></div>}
    </>}
    {result && <div><h5>{result.transactionCode}</h5>{result.quote && <QuoteDetails quote={result.quote} />}
      {result.transactionStatus === 'PENDING' && <><p>Đề nghị chờ thu — gói nguồn và lịch PT chưa chuyển.</p>
        {result.quote && now >= Date.parse(result.quote.quoteExpiresAt) && <p role="alert">{guidance.QUOTE_EXPIRED}</p>}
        <p>Tìm {result.transactionCode} để đối chiếu/thu. Hủy chờ qua mục đăng ký gói, có lý do; hết hạn không tự hủy.</p>
        <Link to={`/${apiClient.getSnapshot().user?.roleCode === 'ADMIN' ? 'admin' : 'staff'}/transactions`}>Đối chiếu và thu nâng cấp</Link></>}
      {result.transactionStatus === 'SETTLED' && <><p>Đã thay thế gói nguồn (SUPERSEDED); kỳ mới: {result.startDate} → {result.endDate}</p>
        <p>Buổi đã dùng mang sang: {result.carriedSessionsUsed ?? 0}. COMPLETED/CANCELLED vẫn giữ gói cũ.</p>
        <p>Membership mới: {result.membershipId} · Chứng từ: {result.invoiceNumber ?? result.invoiceId}</p></>}
      {result.transactionStatus === 'CANCELLED' && <p>Đề nghị đã hủy; gói nguồn giữ nguyên.</p>}
      <button type="button" disabled={busy || !!command} onClick={() => void run(async () => accepted(await salesApi.detail(result.saleId)))}>Tải kết quả chuyển gói</button>
    </div>}
  </section>;
}
