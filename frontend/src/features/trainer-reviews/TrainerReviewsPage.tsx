// Tầng giao diện – trang (US-31 bước 3): trang /trainer/reviews – PT xem điểm và nhận xét học viên gửi cho các buổi mình dạy.
// Chỉ đọc (US-31-F04): không có nút sửa/xóa/ẩn/trả lời. Số lượt và điểm trung bình lấy NGUYÊN từ server, không tự tính.
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ApiError, apiClient } from '../../api/client';
import { Icon } from '../../components/Icon';
import { formatAsOf, formatDate, formatRange } from '../pt-bookings/pt-booking-format';
import { trainerReviewsApi, type TrainerReview, type TrainerReviewFilter, type TrainerReviewPage } from './trainer-reviews.api';

const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);

// Giờ buổi tập theo giờ Việt Nam: "09:00–10:00 18/11/2026".
const sessionTime = (review: TrainerReview) => `${formatRange(review.booking.startAt, review.booking.endAt)} ${formatDate(review.booking.startAt)}`;

// Lỗi tải chi tiết: retryReviewId có khi lỗi tạm thời (mạng/503) để "Thử lại" đúng review đó; 404 thì không có.
type DetailError = { text: string; retryReviewId?: string } | null;

export function TrainerReviewsPage() {
  // US-31-TC11: đổi account/đăng xuất → key đổi → React bỏ toàn bộ state của account cũ (danh sách, tổng quan, chi tiết)
  // ngay lập tức rồi dựng lại và tải theo account mới.
  const auth = useSyncExternalStore(apiClient.subscribe, apiClient.getSnapshot);
  const accountId = auth.status === 'authenticated' ? auth.user?.id : undefined;
  return <section className="auth-card trainer-reviews">
    <h2>Đánh giá của học viên</h2>
    {accountId ? <TrainerReviewsContent key={accountId} /> : <p>Vui lòng đăng nhập để xem đánh giá.</p>}
  </section>;
}

function TrainerReviewsContent() {
  // Giá trị đang gõ trong bộ lọc; chỉ áp dụng khi bấm "Lọc".
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [rating, setRating] = useState('');
  // Điều kiện tải danh sách: đổi object này (kể cả cùng giá trị) là tải lại. Lần đầu không gửi ngày/điểm (server mặc định 30 ngày).
  const [filter, setFilter] = useState<TrainerReviewFilter>({ fromDate: '', toDate: '', rating: '', page: 1 });
  const [list, setList] = useState<TrainerReviewPage | null>(null);
  const [listError, setListError] = useState('');

  const [detail, setDetail] = useState<TrainerReview | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<DetailError>(null);
  // Kết quả tải cũ về muộn (đã lọc/mở review khác) thì bỏ qua.
  const latestList = useRef(0);
  const latestDetail = useRef(0);

  // US-31-TC05, TC06: GET /me/trainer-reviews theo bộ lọc và trang đang chọn.
  useEffect(() => {
    const loadNumber = ++latestList.current;
    setList(null);
    setListError('');
    trainerReviewsApi.list(filter).then(
      page => { if (loadNumber === latestList.current) setList(page); },
      // US-31-TC11: lỗi mạng/503 hiện như lỗi kèm "Thử lại", KHÔNG hiện như "Chưa có đánh giá".
      error => { if (loadNumber === latestList.current) setListError(errorMessage(error, 'Không tải được danh sách đánh giá.')); },
    );
  }, [filter]);

  // US-31-TC05: lọc luôn quay về trang 1.
  function applyFilter(event: FormEvent) {
    event.preventDefault();
    setFilter({ fromDate, toDate, rating, page: 1 });
  }

  // US-31-TC12: mỗi lần mở đều hỏi lại server (server kiểm owner), không dùng dữ liệu của thẻ trong danh sách.
  async function openDetail(reviewId: string) {
    const loadNumber = ++latestDetail.current;
    // Xóa ngay chi tiết cũ để không hiện nhầm buổi khác.
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const review = await trainerReviewsApi.detail(reviewId);
      if (loadNumber === latestDetail.current) setDetail(review);
    } catch (error) {
      if (loadNumber !== latestDetail.current) return;
      if (error instanceof ApiError && error.status === 404) {
        // US-31-TC12: review không còn thuộc PT này → thử lại cũng không ra nên không có nút "Thử lại".
        setDetailError({ text: 'Không tìm thấy đánh giá.' });
      } else {
        setDetailError({ text: errorMessage(error, 'Không tải được chi tiết đánh giá.'), retryReviewId: reviewId });
      }
    } finally {
      if (loadNumber === latestDetail.current) setDetailLoading(false);
    }
  }

  function retryDetail() {
    if (detailError?.retryReviewId) void openDetail(detailError.retryReviewId);
  }

  return <>
    <form onSubmit={applyFilter} className="trainer-reviews-filter">
      <label htmlFor="review-from-date">Từ ngày</label>
      <input id="review-from-date" type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} />
      <label htmlFor="review-to-date">Đến ngày</label>
      <input id="review-to-date" type="date" value={toDate} onChange={event => setToDate(event.target.value)} />
      <label htmlFor="review-rating">Điểm</label>
      <select id="review-rating" value={rating} onChange={event => setRating(event.target.value)}>
        <option value="">Tất cả</option>
        {['1', '2', '3', '4', '5'].map(value => <option key={value} value={value}>{value} sao</option>)}
      </select>
      <button type="submit"><Icon name="filter" label="Lọc" /></button>
    </form>

    {/* US-31-TC04: account PT chưa có hồ sơ PT là trạng thái bình thường, không phải lỗi; không hiện điểm 0. */}
    {list && !list.profileLinked && <p>Tài khoản của bạn chưa được liên kết hồ sơ PT nên chưa có đánh giá.</p>}

    <section aria-labelledby="review-summary-title">
      <h3 id="review-summary-title">Tổng quan đánh giá</h3>
      {/* US-31-TC06, TC07: lấy nguyên summary của server (toàn bộ tập lọc); làm tròn 2 số lẻ khi hiển thị (F05). */}
      {list?.profileLinked && <>
        <p>Số lượt: {list.summary.reviewCount}</p>
        <p>Điểm trung bình: {list.summary.averageRating === null ? 'chưa có' : list.summary.averageRating.toFixed(2)}</p>
      </>}
    </section>

    <section aria-labelledby="review-list-title">
      <h3 id="review-list-title">Danh sách đánh giá</h3>
      {listError && <div role="alert">
        <p>{listError}</p>
        <button type="button" onClick={() => setFilter({ ...filter })}><Icon name="retry" label="Thử lại" /></button>
      </div>}
      {!list && !listError && <p>Đang tải danh sách đánh giá...</p>}
      {/* US-31-F02: buổi chưa có review không thành dòng điểm 0; tập rỗng ghi "Chưa có đánh giá". */}
      {list?.profileLinked && list.items.length === 0 && <p>Chưa có đánh giá</p>}
      {list?.items.map(review => <article key={review.id} aria-label={`Đánh giá ${review.id}`}>
        {/* US-31-TC09: tên và nhận xét hiện như chữ thường – React tự thoát HTML, URL không thành link. */}
        <p><strong>{review.memberDisplayName}</strong></p>
        <p>Điểm: {review.rating}/5</p>
        <p>{review.comment}</p>
        <p>Gửi lúc {formatAsOf(review.createdAt)}</p>
        <p>Buổi tập: {sessionTime(review)}</p>
        <button type="button" onClick={() => void openDetail(review.id)}>Xem chi tiết</button>
      </article>)}
      {list && list.page > 1 && <button type="button" onClick={() => setFilter({ ...filter, page: filter.page - 1 })}><Icon name="prev" label="Trang trước" /></button>}
      {list && list.totalPages > list.page && <button type="button" onClick={() => setFilter({ ...filter, page: filter.page + 1 })}><Icon name="next" label="Trang sau" /></button>}
    </section>

    {detailLoading && <p>Đang tải chi tiết đánh giá...</p>}
    {detailError && <div role="alert">
      <p>{detailError.text}</p>
      {detailError.retryReviewId && <button type="button" onClick={retryDetail}><Icon name="retry" label="Thử lại" /></button>}
    </div>}
    {detail && <ReviewDetailView review={detail} />}
  </>;
}

// US-31-TC12: chi tiết một đánh giá – mã buổi và giờ buổi lấy từ API đích (đã kiểm owner). Chỉ hiển thị, không có nút ghi.
function ReviewDetailView({ review }: { review: TrainerReview }) {
  return <section aria-labelledby="review-detail-title">
    <h3 id="review-detail-title">Chi tiết đánh giá</h3>
    <p><strong>{review.memberDisplayName}</strong></p>
    <p>Điểm: {review.rating}/5</p>
    <p>{review.comment}</p>
    <p>Gửi lúc {formatAsOf(review.createdAt)}</p>
    <p>Mã buổi: {review.booking.id}</p>
    <p>Buổi tập: {sessionTime(review)}</p>
  </section>;
}
