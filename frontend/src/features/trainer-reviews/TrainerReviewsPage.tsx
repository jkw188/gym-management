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

// US-31-TC08 (spec 1.4): lỗi 400 của bộ lọc → hiện đúng message trong details (vd "Chỉ xem tối đa 366 ngày mỗi lần").
// Không có details thì dùng message chung của server.
function filterErrorText(error: ApiError): string {
  const details = error.details ?? [];
  if (details.length === 0) return error.message || 'Bộ lọc không hợp lệ.';
  return details.map(detail => detail.message).join(' ');
}

// Lỗi tải chi tiết: retryReviewId có khi lỗi tạm thời (mạng/503) để "Thử lại" đúng review đó; 404 thì không có.
type DetailError = { text: string; retryReviewId?: string } | null;

// Lần đầu không gửi ngày/điểm: server mặc định 30 ngày gần nhất, mọi điểm.
const INITIAL_FILTER: TrainerReviewFilter = { fromDate: '', toDate: '', rating: '', page: 1 };

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
  const [filter, setFilter] = useState<TrainerReviewFilter>(INITIAL_FILTER);
  const [list, setList] = useState<TrainerReviewPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  // US-31-TC08: lỗi do bộ lọc người dùng nhập (400) – hiện cạnh bộ lọc, KHÔNG có "Thử lại" vì gửi lại vẫn sai.
  const [filterError, setFilterError] = useState('');
  // Bộ lọc đã tạo ra danh sách đang hiển thị. Bộ lọc mới bị 400 thì danh sách cũ vẫn giữ, nên nút trang và
  // tải lại khi có mạng phải dùng bộ lọc này, không dùng bộ lọc sai.
  const shownFilter = useRef<TrainerReviewFilter>(INITIAL_FILTER);
  // true khi lần tải gần nhất bị 400 (bộ lọc sai); false khi tải được hoặc lỗi mạng/503 (bộ lọc vẫn đúng).
  const lastFilterRejected = useRef(false);

  const [detail, setDetail] = useState<TrainerReview | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<DetailError>(null);
  // Kết quả tải cũ về muộn (đã lọc/mở review khác) thì bỏ qua.
  const latestList = useRef(0);
  const latestDetail = useRef(0);

  // US-31-TC05, TC06: GET /me/trainer-reviews theo bộ lọc và trang đang chọn.
  useEffect(() => {
    const loadNumber = ++latestList.current;
    // Danh sách cũ vẫn hiện trong lúc tải; chỉ thay khi có kết quả mới.
    setLoading(true);
    setListError('');
    setFilterError('');
    trainerReviewsApi.list(filter).then(
      page => {
        if (loadNumber !== latestList.current) return;
        setList(page);
        shownFilter.current = filter;
        lastFilterRejected.current = false;
        setLoading(false);
      },
      error => {
        if (loadNumber !== latestList.current) return;
        setLoading(false);
        // US-31-TC08: 400 là bộ lọc sai (kỳ sai, quá 366 ngày…) → báo lý do cạnh bộ lọc để người dùng sửa.
        // Giữ danh sách và tổng quan của bộ lọc trước (có ghi chú), không xóa trắng màn hình.
        if (error instanceof ApiError && error.status === 400) {
          lastFilterRejected.current = true;
          setFilterError(filterErrorText(error));
          return;
        }
        // US-31-TC11: lỗi mạng/503 → bỏ dữ liệu, hiện lỗi kèm "Thử lại", KHÔNG hiện như "Chưa có đánh giá".
        lastFilterRejected.current = false;
        setList(null);
        setListError(errorMessage(error, 'Không tải được danh sách đánh giá.'));
      },
    );
  }, [filter]);

  // US-31-TC11 (spec 1.4): trình duyệt có mạng lại (sự kiện 'online') → tải lại danh sách theo bộ lọc HIỆN TẠI
  // (bộ lọc vừa bấm "Lọc", giống nút "Thử lại"). Riêng khi bộ lọc đó bị 400 thì gửi lại vẫn sai → tải lại bộ lọc đang hiển thị.
  // Tạo object mới cùng giá trị để effect ở trên chạy lại. Rời trang thì gỡ listener để không gọi API nữa.
  useEffect(() => {
    const reload = () => setFilter(current => ({ ...(lastFilterRejected.current ? shownFilter.current : current) }));
    window.addEventListener('online', reload);
    return () => window.removeEventListener('online', reload);
  }, []);

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
    {/* Bộ lọc gọn một hàng: mỗi ô gồm nhãn nằm trên ô nhập, nút Lọc ở cuối hàng. */}
    <form onSubmit={applyFilter} className="trainer-reviews-filter">
      <div className="review-field">
        <label htmlFor="review-from-date">Từ ngày</label>
        <input id="review-from-date" type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} />
      </div>
      <div className="review-field">
        <label htmlFor="review-to-date">Đến ngày</label>
        <input id="review-to-date" type="date" value={toDate} onChange={event => setToDate(event.target.value)} />
      </div>
      <div className="review-field">
        <label htmlFor="review-rating">Điểm</label>
        <select id="review-rating" value={rating} onChange={event => setRating(event.target.value)}>
          <option value="">Tất cả</option>
          {['1', '2', '3', '4', '5'].map(value => <option key={value} value={value}>{value} sao</option>)}
        </select>
      </div>
      <button type="submit"><Icon name="filter" label="Lọc" /></button>
      {filterError && <p role="alert" className="review-filter-note">{filterError}</p>}
      {/* Bộ lọc mới bị từ chối nhưng vẫn giữ kết quả cũ → ghi rõ để không hiểu nhầm số liệu là của bộ lọc mới (F05). */}
      {filterError && list && <p className="review-filter-note">Đang hiển thị kết quả của bộ lọc trước.</p>}
    </form>

    {/* US-31-TC04: account PT chưa có hồ sơ PT là trạng thái bình thường, không phải lỗi; không hiện điểm 0. */}
    {list && !list.profileLinked && <p>Tài khoản của bạn chưa được liên kết hồ sơ PT nên chưa có đánh giá.</p>}

    <section aria-labelledby="review-summary-title">
      <h3 id="review-summary-title">Tổng quan đánh giá</h3>
      {/* US-31-TC06, TC07: lấy nguyên summary của server (toàn bộ tập lọc); làm tròn 2 số lẻ khi hiển thị (F05). */}
      {/* Hai số liệu nằm trên cùng một dòng. */}
      {list?.profileLinked && <p className="review-summary-line">
        <span>Số lượt: <strong>{list.summary.reviewCount}</strong></span>
        <span>Điểm trung bình: <strong>{list.summary.averageRating === null ? 'chưa có' : list.summary.averageRating.toFixed(2)}</strong></span>
      </p>}
    </section>

    <section aria-labelledby="review-list-title">
      <h3 id="review-list-title">Danh sách đánh giá</h3>
      {listError && <div role="alert">
        <p>{listError}</p>
        <button type="button" onClick={() => setFilter({ ...filter })}><Icon name="retry" label="Thử lại" /></button>
      </div>}
      {loading && <p>Đang tải danh sách đánh giá...</p>}
      {/* US-31-F02: buổi chưa có review không thành dòng điểm 0; tập rỗng ghi "Chưa có đánh giá". */}
      {list?.profileLinked && list.items.length === 0 && <p>Chưa có đánh giá</p>}
      {list?.items.map(review => <article key={review.id} aria-label={`Đánh giá ${review.id}`} className="review-card">
        {/* US-31-TC09: tên và nhận xét hiện như chữ thường – React tự thoát HTML, URL không thành link. */}
        {/* Dòng 1: tên, điểm, giờ buổi tập. Dòng 2: nhận xét. Dòng 3: giờ gửi và nút chi tiết. */}
        <div className="review-card-head">
          <strong>{review.memberDisplayName}</strong>
          <span>Điểm: {review.rating}/5</span>
          <span className="review-muted">Buổi tập: {sessionTime(review)}</span>
        </div>
        {review.comment && <p className="review-comment">{review.comment}</p>}
        <div className="review-card-foot">
          <span className="review-muted">Gửi lúc {formatAsOf(review.createdAt)}</span>
          <button type="button" onClick={() => void openDetail(review.id)}>Xem chi tiết</button>
        </div>
      </article>)}
      <div className="pagination">{list && list.page > 1 && <button type="button" onClick={() => setFilter({ ...shownFilter.current, page: list.page - 1 })}><Icon name="prev" label="Trang trước" /></button>}
      {list && list.totalPages > list.page && <button type="button" onClick={() => setFilter({ ...shownFilter.current, page: list.page + 1 })}><Icon name="next" label="Trang sau" /></button>}</div>
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
  return <section aria-labelledby="review-detail-title" className="review-card">
    <h3 id="review-detail-title">Chi tiết đánh giá</h3>
    <div className="review-card-head">
      <strong>{review.memberDisplayName}</strong>
      <span>Điểm: {review.rating}/5</span>
    </div>
    {review.comment && <p className="review-comment">{review.comment}</p>}
    <div className="review-card-head review-muted">
      <span>Gửi lúc {formatAsOf(review.createdAt)}</span>
      <span>Buổi tập: {sessionTime(review)}</span>
      <span>Mã buổi: {review.booking.id}</span>
    </div>
  </section>;
}
