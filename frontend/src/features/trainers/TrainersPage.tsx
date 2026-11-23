import { useEffect, useRef, useState } from 'react';
import { TrainerForm } from './TrainerForm';
import { trainersApi, type Trainer, type TrainerPage, type TrainerQuery, type TrainerSummary } from './trainers.api';

export function TrainersPage() {
  const [query, setQuery] = useState<TrainerQuery>({ page: 1, limit: 20 });
  const [q, setQ] = useState('');
  const [data, setData] = useState<TrainerPage<TrainerSummary>>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<Trainer | 'new'>();
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState('');
  const detailRequest = useRef<AbortController | null>(null);
  useEffect(() => () => detailRequest.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    trainersApi.list(query, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Không tải được hồ sơ PT.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, revision]);
  async function open(id: string) {
    detailRequest.current?.abort();
    const controller = new AbortController(); detailRequest.current = controller;
    setOpening(true); setError(''); setNotice('');
    try { const result = await trainersApi.detail(id, controller.signal); if (!controller.signal.aborted) setEditing(result); }
    catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Không tải được hồ sơ.'); }
    finally { if (!controller.signal.aborted) setOpening(false); }
  }
  return <section className="auth-card"><h2>Quản lý huấn luyện viên</h2>
    <p>Quản lý chuyên môn, liên kết tài khoản và trạng thái nhận lịch của PT.</p>{notice && <p role="status">{notice}</p>}
    {editing ? <TrainerForm key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? undefined : editing}
      onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); setNotice('Đã lưu hồ sơ PT.'); setRevision(value => value + 1); }} /> : <>
      <form className="users-filter toolbar" onSubmit={event => { event.preventDefault(); setQuery({ ...query, q, page: 1 }); }}>
        <div><label htmlFor="trainer-search">Tìm tên, số điện thoại hoặc chuyên môn</label><input id="trainer-search" maxLength={120} value={q} onChange={e => setQ(e.target.value)} /></div>
        <div><label htmlFor="trainer-filter-status">Lọc trạng thái PT</label><select id="trainer-filter-status" value={query.status ?? ''} onChange={e => setQuery({ ...query, status: e.target.value, page: 1 })}><option value="">Tất cả</option><option value="ACTIVE">Hoạt động</option><option value="INACTIVE">Ngừng hoạt động</option></select></div>
        <button type="submit">Tìm PT</button></form>
      <button disabled={opening} onClick={() => { setNotice(''); setEditing('new'); }}>Tạo hồ sơ PT</button>
      {(loading || opening) && <p role="status">Đang tải hồ sơ PT…</p>}{error && <><p role="alert">{error}</p><button onClick={() => setRevision(value => value + 1)}>Thử lại</button></>}
      {!loading && !error && data && <>
        {data.items.length === 0 ? <p>Chưa có hồ sơ PT phù hợp.</p> : <div className="users-table-wrap"><table className="users-table"><thead><tr><th>PT</th><th>Chuyên môn</th><th>Trạng thái</th><th>Phiên bản</th><th>Thao tác</th></tr></thead><tbody>
          {data.items.map(trainer => <tr key={trainer.id}><td>{trainer.fullName}</td><td>{trainer.specialty}</td><td>{trainer.status === 'ACTIVE' ? 'Hoạt động' : 'Ngừng hoạt động'}</td><td>{trainer.version}</td><td><button disabled={opening} onClick={() => void open(trainer.id)}>Xem / sửa {trainer.fullName}</button></td></tr>)}
        </tbody></table></div>}
        <div className="pagination"><button disabled={query.page <= 1 || opening} onClick={() => setQuery({ ...query, page: query.page - 1 })}>Trang trước</button><span>Trang {query.page} / {data.totalPages} — {data.total} kết quả</span>
          <button disabled={query.page >= data.totalPages || opening} onClick={() => setQuery({ ...query, page: query.page + 1 })}>Trang sau</button></div>
      </>}
    </>}
  </section>;
}
