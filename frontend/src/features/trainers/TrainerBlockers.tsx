import { useEffect, useState } from 'react';
import { trainersApi, type BlockerPage } from './trainers.api';

export const blockerNames = { BOOKING: 'Lịch PT', SHIFT: 'Ca làm việc', PUBLIC_SESSION: 'Lớp miễn phí' };
const dateTime = (value: string) => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
export function TrainerBlockers({ trainerId }: { trainerId: string }) {
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState('');
  const [data, setData] = useState<BlockerPage>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    trainersApi.blockers(trainerId, page, kind, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Không tải được trở ngại.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [trainerId, page, kind, revision]);
  return <section aria-label="Trở ngại ngừng hoạt động"><h4>Trở ngại ngừng hoạt động</h4>
    <p>Hủy hỗ trợ lịch PT, xử lý lớp qua chức năng quản lý lớp và yêu cầu PT xử lý ca trước. Lịch đang diễn ra cần kết thúc theo quy định.</p>
    <p>Số liệu chỉ hỗ trợ lập kế hoạch; máy chủ kiểm tra lại khi lưu.</p>
    <label htmlFor="blocker-kind">Loại trở ngại</label><select id="blocker-kind" value={kind} onChange={e => { setKind(e.target.value); setPage(1); }}>
      <option value="">Tất cả</option>{Object.entries(blockerNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    <button type="button" onClick={() => setRevision(value => value + 1)}>Tải lại trở ngại</button>
    {loading && <p role="status">Đang tải trở ngại…</p>}{error && <p role="alert">{error}</p>}
    {!loading && !error && data && <>
      <p>Lịch PT: {data.counts.BOOKING} · Ca: {data.counts.SHIFT} · Lớp: {data.counts.PUBLIC_SESSION}. Cập nhật {dateTime(data.asOf)}.</p>
      {data.items.length === 0 ? <p>Không có trở ngại phù hợp.</p> : <div className="users-table-wrap"><table className="users-table"><thead><tr><th>Loại / mã</th><th>Bắt đầu</th><th>Kết thúc</th><th>Trạng thái</th><th>Xử lý</th></tr></thead>
        <tbody>{data.items.map(item => <tr key={`${item.kind}:${item.id}`}><td>{blockerNames[item.kind]}<small>{item.id}</small></td><td>{dateTime(item.startAt)}</td><td>{dateTime(item.endAt)}</td><td>{item.status}</td>
          <td>{item.kind === 'BOOKING' ? <a href="/admin/pt-bookings" target="_blank" rel="noreferrer">Mở hủy hỗ trợ</a> : item.kind === 'SHIFT' ? 'Yêu cầu PT xử lý ca' : 'Xử lý qua quản lý lớp'}</td></tr>)}</tbody></table></div>}
      <div className="user-actions"><button type="button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Trở ngại trước</button><span>Trang {page} / {data.totalPages}</span>
        <button type="button" disabled={page >= data.totalPages} onClick={() => setPage(value => value + 1)}>Trở ngại sau</button></div>
    </>}
  </section>;
}
