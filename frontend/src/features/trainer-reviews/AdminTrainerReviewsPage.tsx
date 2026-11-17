import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ApiError, apiClient } from '../../api/client';
import { formatAsOf } from '../pt-bookings/pt-booking-format';
import { adminTrainerReviewsApi as api, type AdminReview, type AdminReviewFilter, type AdminReviewPage, type AdminTrainerSummary, type ReviewMetrics } from './admin-trainer-reviews.api';

const INITIAL: AdminReviewFilter = { trainerId: '', fromDate: '', toDate: '', rating: '' };
const errorText = (error: unknown) => error instanceof ApiError
  ? error.details?.map(item => item.message).join(' ') || error.message : 'Không tải được dữ liệu. Vui lòng thử lại.';

export function AdminTrainerReviewsPage() {
  const auth = useSyncExternalStore(apiClient.subscribe, apiClient.getSnapshot);
  return <section className="auth-card trainer-reviews">
    <h2>Tổng hợp đánh giá PT</h2>
    {auth.status === 'authenticated' && auth.user?.roleCode === 'ADMIN'
      ? <ReviewContent key={auth.user.id} /> : <p>Không có quyền truy cập.</p>}
  </section>;
}

function Metrics({ value }: { value: ReviewMetrics }) {
  return <>
    <p>Số lượt: {value.reviewCount}</p>
    <p>Điểm trung bình: {value.averageRating === null ? '— (Chưa có đánh giá)' : value.averageRating.toFixed(2)}</p>
    <p>Phân bố: {[1, 2, 3, 4, 5].map(star => `${star} sao: ${value.distribution[String(star)]}`).join(' · ')}</p>
  </>;
}
function Pagination({ data, change }: { data: AdminReviewPage<unknown>; change: (page: number) => void }) {
  return <div className="pagination">
    <span>{data.total} bản ghi · Trang {data.totalPages ? data.page : 0}/{data.totalPages}</span>
    <button disabled={data.page <= 1} onClick={() => change(data.page - 1)}>Trang trước</button>
    <button disabled={data.page >= data.totalPages} onClick={() => change(data.page + 1)}>Trang sau</button>
  </div>;
}
function ReviewSource({ review }: { review: AdminReview }) {
  return <>
    <p>PT lúc gửi: {review.trainerNameSnapshot || 'Chưa có tên snapshot'} · Mã PT: {review.trainerId}</p>
    <p>Học viên lúc gửi: {review.memberDisplayName || 'Chưa có tên snapshot'}</p>
    <p>Điểm: {review.rating}/5</p>
    <p style={{ whiteSpace: 'pre-wrap' }}>{review.comment || 'Không có nhận xét'}</p>
    <p>Gửi lúc: {formatAsOf(review.createdAt)}</p>
    <p>Mã buổi: {review.booking.id}</p>
    <p>Buổi tập: {formatAsOf(review.booking.startAt)} – {formatAsOf(review.booking.endAt)}</p>
  </>;
}

function ReviewContent() {
  const [draft, setDraft] = useState<AdminReviewFilter>(INITIAL);
  const [filter, setFilter] = useState<AdminReviewFilter>(INITIAL);
  const [summaryPage, setSummaryPage] = useState(1);
  const [reviewPage, setReviewPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [summary, setSummary] = useState<AdminReviewPage<AdminTrainerSummary> | null>(null);
  const [list, setList] = useState<AdminReviewPage<AdminReview> | null>(null);
  const [summaryError, setSummaryError] = useState('');
  const [listError, setListError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const [detail, setDetail] = useState<AdminReview | null>(null);
  const [detailError, setDetailError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setSummary(null); setSummaryError('');
    api.summary(filter, summaryPage, controller.signal).then(
      data => { if (!controller.signal.aborted) setSummary(data); },
      error => { if (!controller.signal.aborted) setSummaryError(errorText(error)); },
    );
    return () => controller.abort();
  }, [filter, summaryPage, reload]);

  useEffect(() => {
    const controller = new AbortController();
    setList(null); setListError('');
    api.list(filter, reviewPage, controller.signal).then(
      data => { if (!controller.signal.aborted) setList(data); },
      error => { if (!controller.signal.aborted) setListError(errorText(error)); },
    );
    return () => controller.abort();
  }, [filter, reviewPage, reload]);

  useEffect(() => {
    const refresh = () => { setReload(value => value + 1); setDetailReload(value => value + 1); };
    window.addEventListener('online', refresh);
    return () => window.removeEventListener('online', refresh);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null); setDetailError('');
    if (selectedId) api.detail(selectedId, controller.signal).then(
      data => { if (!controller.signal.aborted) setDetail(data); },
      error => { if (!controller.signal.aborted) setDetailError(errorText(error)); },
    );
    return () => controller.abort();
  }, [selectedId, detailReload]);

  function apply(event: FormEvent) {
    event.preventDefault();
    setFilter({ ...draft }); setSummaryPage(1); setReviewPage(1); setSelectedId(null); setDetail(null);
  }
  function selectTrainer(trainerId: string) {
    setDraft(current => ({ ...current, trainerId }));
    setFilter(current => ({ ...current, trainerId })); setSummaryPage(1); setReviewPage(1); setSelectedId(null); setDetail(null);
  }

  return <>
    <form onSubmit={apply} className="trainer-reviews-filter">
      <label>Mã PT (để trống xem toàn phòng)<input value={draft.trainerId} maxLength={24} onChange={event => setDraft({ ...draft, trainerId: event.target.value })} /></label>
      <label>Từ ngày gửi<input type="date" value={draft.fromDate} onChange={event => setDraft({ ...draft, fromDate: event.target.value })} /></label>
      <label>Đến ngày gửi<input type="date" value={draft.toDate} onChange={event => setDraft({ ...draft, toDate: event.target.value })} /></label>
      <label>Điểm<select value={draft.rating} onChange={event => setDraft({ ...draft, rating: event.target.value })}>
        <option value="">Tất cả</option>{[1, 2, 3, 4, 5].map(star => <option key={star} value={star}>{star} sao</option>)}
      </select></label>
      <button type="submit">Lọc</button>
      <button type="button" onClick={() => { setReload(value => value + 1); setDetailReload(value => value + 1); }}>Tải lại</button>
    </form>
    <p>Bộ lọc áp dụng: PT {filter.trainerId || 'toàn phòng'} · Điểm {filter.rating || 'tất cả'}.</p>
    <p>Kỳ gửi theo giờ Việt Nam; tối đa 366 ngày. Bỏ trống ngày dùng kỳ mặc định 30 ngày đến hôm nay hoặc đến ngày cuối đã chọn.</p>

    <section aria-labelledby="admin-review-summary">
      <h3 id="admin-review-summary">Tổng hợp theo PT</h3>
      {summaryError && <p role="alert">{summaryError} <button onClick={() => setReload(value => value + 1)}>Thử lại</button></p>}
      {!summary && !summaryError && <p>Đang tải tổng hợp...</p>}
      {summary && <>
        <p>Kỳ gửi: {summary.range.fromDate} – {summary.range.toDate} · Giờ VN · Đọc lúc {formatAsOf(summary.asOf)}</p>
        <section aria-label="Tổng toàn tập lọc"><h4>Tổng toàn tập lọc</h4><Metrics value={summary.totals} /></section>
        {summary.invalidReviewCount > 0 && <p role="status">Có {summary.invalidReviewCount} đánh giá không hợp lệ đã loại khỏi điểm; xem log ID để đối soát.</p>}
        {summary.items.length === 0 && <p>Không có PT trong trang này.</p>}
        {summary.items.map(trainer => <article key={trainer.trainerId} aria-label={`PT ${trainer.trainerId}`}>
          <h4>{trainer.currentTrainerName || 'Chưa có tên PT hiện tại'}</h4>
          <p>Tên PT hiện tại · {trainer.status === 'INACTIVE' ? 'Ngừng hoạt động' : trainer.status === 'ACTIVE' ? 'Đang hoạt động' : 'Chưa có trạng thái'}</p>
          <p>Mã PT: {trainer.trainerId}</p><Metrics value={trainer} />
          <button onClick={() => selectTrainer(trainer.trainerId)}>Xem nhận xét của PT</button>
        </article>)}
        <Pagination data={summary} change={setSummaryPage} />
      </>}
    </section>

    <section aria-labelledby="admin-review-list">
      <h3 id="admin-review-list">Nhận xét gốc</h3>
      {listError && <p role="alert">{listError} <button onClick={() => setReload(value => value + 1)}>Thử lại</button></p>}
      {!list && !listError && <p>Đang tải nhận xét...</p>}
      {list && <>
        <p>Kỳ gửi: {list.range.fromDate} – {list.range.toDate} · Đọc lúc {formatAsOf(list.asOf)}. Phân trang độc lập với tổng hợp.</p>
        {list.items.length === 0 && <p>Chưa có đánh giá trong trang này.</p>}
        {list.items.map(review => <article key={review.id} aria-label={`Đánh giá ${review.id}`}>
          <ReviewSource review={review} />
          <button onClick={() => { setSelectedId(review.id); setDetail(null); setDetailReload(value => value + 1); }}>Mở đánh giá gốc</button>
        </article>)}
        <Pagination data={list} change={setReviewPage} />
      </>}
    </section>
    {selectedId && <section aria-labelledby="admin-review-detail">
      <h3 id="admin-review-detail">Chi tiết đánh giá</h3>
      {detailError && <p role="alert">{detailError} <button onClick={() => setDetailReload(value => value + 1)}>Thử lại</button></p>}
      {!detail && !detailError && <p>Đang tải chi tiết...</p>}
      {detail && <><p>Mã đánh giá: {detail.id}</p><ReviewSource review={detail} /></>}
      <button onClick={() => setSelectedId(null)}>Đóng chi tiết</button>
    </section>}
  </>;
}
