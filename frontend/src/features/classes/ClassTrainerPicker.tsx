import { useEffect, useId, useState } from 'react';
import { trainersApi, type TrainerPage, type TrainerSummary } from '../trainers/trainers.api';

export function ClassTrainerPicker({ value, name, onChange, required = false }: {
  value: string; name?: string | null; onChange: (id: string) => void; required?: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<TrainerPage<TrainerSummary>>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    trainersApi.list({ page, limit: 20, q, ...(required ? { status: 'ACTIVE' } : {}) }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(() => { if (!controller.signal.aborted) setError('Không tải được danh sách PT.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [q, page, revision, required]);
  return <div>
    <label htmlFor={`${id}-search`}>Tìm PT theo tên</label><input id={`${id}-search`} value={search} maxLength={120} onChange={e => setSearch(e.target.value)} />
    <button type="button" onClick={() => { setQ(search); setPage(1); setRevision(n => n + 1); }}>Tìm PT</button>
    {loading && <p role="status">Đang tải PT…</p>}{error && <p role="alert">{error} <button type="button" onClick={() => setRevision(n => n + 1)}>Tải lại PT</button></p>}
    <label htmlFor={`${id}-trainer`}>{required ? 'Huấn luyện viên' : 'Lọc PT'}</label>
    <select id={`${id}-trainer`} value={value} required={required} onChange={e => onChange(e.target.value)}>
      <option value="">{required ? 'Chọn PT' : 'Tất cả PT'}</option>
      {value && !data?.items.some(row => row.id === value) && <option value={value}>{name ?? value}</option>}
      {!loading && !error && data?.items.map(row => <option key={row.id} value={row.id}>{row.fullName} — {row.specialty}</option>)}
    </select>
    {!loading && !error && data?.items.length === 0 && <p>Không có PT phù hợp.</p>}
    {data && data.totalPages > 1 && <div className="user-actions"><button type="button" disabled={loading || page <= 1} onClick={() => setPage(n => n - 1)}>PT trước</button>
      <span>{page}/{data.totalPages}</span><button type="button" disabled={loading || page >= data.totalPages} onClick={() => setPage(n => n + 1)}>PT sau</button></div>}
  </div>;
}
