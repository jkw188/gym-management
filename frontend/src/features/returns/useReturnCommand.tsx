import { useEffect, useRef, useState } from 'react';
import { ApiError, apiClient } from '../../api/client';

export interface ReturnCommand { key: string; operation: 'RETURN_RECEIVE' | 'REFUND_CONFIRM' | 'REFUND_FAIL'; targetId: string; body: object }
// One unresolved command blocks a new intent, including after navigation/reload. Scoped to the authenticated actor.
export function useReturnCommand<T extends object>(scope: string, onComplete: (result: T) => void | Promise<void>) {
  const actorId = apiClient.getSnapshot().user?.id ?? 'session', storageKey = `us46:${actorId}:${scope}`;
  const [command, setCommand] = useState<ReturnCommand | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as ReturnCommand | null;
      return value && ['RETURN_RECEIVE', 'REFUND_CONFIRM', 'REFUND_FAIL'].includes(value.operation) && typeof value.key === 'string' && value.body && typeof value.targetId === 'string' ? value : null;
    } catch { return null; }
  });
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [denied, setDenied] = useState(false);
  const busy = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const current = () => active.current && (apiClient.getSnapshot().user?.id ?? 'session') === actorId;
  function keep(next: ReturnCommand | null) {
    setCommand(next);
    try { if (next) sessionStorage.setItem(storageKey, JSON.stringify(next)); else sessionStorage.removeItem(storageKey); }
    catch { setError('Không lưu được khóa trên trình duyệt. Giữ trang mở để đối soát.'); }
  }
  async function execute(next: ReturnCommand, lookup = false) {
    if (busy.current || denied || !current()) return;
    busy.current = true; setPending(true); setError(''); keep(next);
    try {
      const path = next.operation === 'RETURN_RECEIVE' ? `/orders/${encodeURIComponent(next.targetId)}/returns` : `/refunds/${encodeURIComponent(next.targetId)}/${next.operation === 'REFUND_CONFIRM' ? 'confirm' : 'fail'}`;
      const result = lookup ? (await apiClient.request<{ responseBody: T }>(`/operations/${next.operation}/${encodeURIComponent(next.key)}`)).responseBody
        : await apiClient.request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': next.key }, body: JSON.stringify(next.body) });
      if (!current()) return;
      keep(null); setNotice(next.operation === 'RETURN_RECEIVE' ? 'Đã nhận hàng trả. Khoản hoàn được đối soát và xác minh thực chi riêng.' : next.operation === 'REFUND_CONFIRM' ? 'Đã xác minh thực chi hoàn tiền.' : 'Đã ghi nhận chưa chi thành công. Nghĩa vụ vẫn còn phải trả.');
      try { await onComplete(result); } catch { if (current()) setError('Đã lưu kết quả; chưa tải lại được dữ liệu. Hãy tải lại.'); }
    } catch (cause) {
      if (!current()) return;
      setError(cause instanceof Error ? cause.message : 'Không thực hiện được yêu cầu');
      if (cause instanceof ApiError && [401, 403].includes(cause.status ?? 0)) setDenied(true);
      if (!lookup && cause instanceof ApiError && cause.status && cause.status < 500 && ![401, 403].includes(cause.status) && cause.code !== 'IDEMPOTENCY_CONFLICT') keep(null);
    } finally { busy.current = false; if (current()) setPending(false); }
  }
  return { command, pending, denied, error, notice, submit(body: object, targetId: string, operation: ReturnCommand['operation']) {
    if (!command) void execute({ body, targetId, operation, key: crypto.randomUUID() });
  }, recover: () => command && void execute(command, true), replay: () => command && void execute(command) };
}
export function CommandRecovery({ state }: { state: Pick<ReturnType<typeof useReturnCommand>, 'command' | 'pending' | 'denied' | 'error' | 'notice' | 'recover' | 'replay'> }) {
  return <>{state.error && <p role="alert">{state.error}</p>}{state.notice && <p role="status">{state.notice}</p>}
    {state.pending && <p role="status">Đang xử lý…</p>}{state.command && <section><p>Chưa xác định kết quả. Giữ khóa {state.command.key}; tra cứu trước khi tạo yêu cầu mới. Không chi lại khi kết quả ngân hàng chưa rõ.</p>
      <button disabled={state.pending || state.denied} onClick={state.recover}>Tra cứu kết quả</button>
      <button disabled={state.pending || state.denied} onClick={state.replay}>Gửi lại cùng yêu cầu</button></section>}</>;
}
