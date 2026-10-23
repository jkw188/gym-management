import { useEffect, useState } from 'react';
import { ApiError, apiGet } from '../../api/client';

type Check = { state: 'loading' | 'success' | 'error'; message: string; requestId?: string };
const loading: Check = { state: 'loading', message: 'Đang kiểm tra…' };

export function FoundationStatus() {
  const [attempt, setAttempt] = useState(0);
  const [live, setLive] = useState<Check>(loading);
  const [ready, setReady] = useState<Check>(loading);
  useEffect(() => {
    const controller = new AbortController();
    setLive(loading); setReady(loading);
    async function check(path: string, expected: string, setResult: (check: Check) => void) {
      try {
        const result = await apiGet<{ status?: string }>(path, controller.signal);
        if (result?.status !== expected) throw new ApiError('Phản hồi kiểm tra không hợp lệ.');
        if (!controller.signal.aborted) setResult({ state: 'success', message: expected === 'ok' ? 'Máy chủ đang hoạt động' : 'MongoDB đã sẵn sàng' });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ state: 'error', message: error instanceof Error ? error.message : 'Không thể kiểm tra kết nối.',
          requestId: error instanceof ApiError ? error.requestId : undefined });
      }
    }
    void check('/health/live', 'ok', setLive);
    void check('/health/ready', 'ready', setReady);
    return () => controller.abort();
  }, [attempt]);
  const pending = live.state === 'loading' || ready.state === 'loading';
  const checks = [{ label: 'Backend', result: live }, { label: 'Cơ sở dữ liệu', result: ready }];
  return <section aria-labelledby="foundation-title">
    <h2 id="foundation-title">Kiểm tra nền tảng</h2>
    <div aria-live="polite" aria-busy={pending}>
      {checks.map(({ label, result }) => <div className={`status-card ${result.state}`} key={label}>
        <h3>{label}</h3><p>{result.message}</p>
        {result.requestId && <small>Mã tra cứu: {result.requestId}</small>}
      </div>)}
    </div>
    <button type="button" disabled={pending} onClick={() => setAttempt(value => value + 1)}>{pending ? 'Đang kiểm tra…' : 'Thử lại'}</button>
  </section>;
}
