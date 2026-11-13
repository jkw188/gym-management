// Tầng giao diện – trang (US-30 bước 3): trang /trainer/trainees – PT tìm học viên của mình, xem lịch với mình và gói liên quan.
// Chỉ hiển thị số liệu server trả (quota, đã dùng, giữ chỗ, còn lại); không có nút hoàn tất buổi hay nhận xét (thuộc S07).
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ApiError, apiClient } from '../../api/client';
import { formatAsOf, formatDate, formatRange, STATUS_LABELS } from '../pt-bookings/pt-booking-format';
import {
  traineesApi, type MembershipStoredStatus, type TraineeBooking, type TraineeDetail, type TraineeListPage, type TraineeMembershipPage,
} from './trainees.api';

// US-30 mục 2 (UI): gói cũ và gói hiện tại có nhãn trạng thái riêng.
const MEMBERSHIP_STATUS_LABELS: Record<MembershipStoredStatus, string> = {
  ACTIVE: 'Đang hiệu lực', SUPERSEDED: 'Đã được thay thế', CANCELLED: 'Đã hủy',
};

// "2026-10-01" → "01/10/2026" (ngày gói là ngày VN, không cần đổi múi giờ).
const formatDay = (day: string) => day.split('-').reverse().join('/');
const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);

// Điều kiện tải danh sách: đổi object này (kể cả cùng giá trị) là tải lại.
type ListParams = { q: string; page: number };
// Ba phần chi tiết của một học viên, tải cùng lúc.
type DetailData = { detail: TraineeDetail; bookings: TraineeBooking[]; memberships: TraineeMembershipPage };

export function TraineesPage() {
  // US-30-TC12: đổi account/đăng xuất → key đổi → React bỏ toàn bộ state của account cũ (danh sách, chi tiết) và dựng lại từ đầu.
  const auth = useSyncExternalStore(apiClient.subscribe, apiClient.getSnapshot);
  const accountId = auth.status === 'authenticated' ? auth.user?.id : undefined;
  return <section className="auth-card trainees">
    <h2>Học viên của tôi</h2>
    {accountId ? <TraineesContent key={accountId} /> : <p>Vui lòng đăng nhập để xem học viên.</p>}
  </section>;
}

function TraineesContent() {
  const [searchText, setSearchText] = useState('');
  const [params, setParams] = useState<ListParams>({ q: '', page: 1 });
  const [list, setList] = useState<TraineeListPage | null>(null);
  const [listError, setListError] = useState('');

  const [detail, setDetail] = useState<DetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  // Kết quả tải cũ về muộn (đã tìm/mở học viên khác) thì bỏ qua.
  const latestList = useRef(0);
  const latestDetail = useRef(0);

  // US-30-TC12: GET /me/trainees theo từ khóa và trang đang chọn.
  useEffect(() => {
    const loadNumber = ++latestList.current;
    setList(null);
    setListError('');
    traineesApi.list(params.q, params.page).then(
      page => { if (loadNumber === latestList.current) setList(page); },
      // Lỗi mạng/503 hiện như lỗi kèm "Thử lại", KHÔNG hiện như danh sách trống.
      error => { if (loadNumber === latestList.current) setListError(errorMessage(error, 'Không tải được danh sách học viên.')); },
    );
  }, [params]);

  // Tìm luôn quay về trang 1. q gửi nguyên văn, server tự trim và tìm literal.
  function search(event: FormEvent) {
    event.preventDefault();
    setParams({ q: searchText, page: 1 });
  }

  // US-30-TC09: mỗi lần mở chi tiết đều hỏi lại server; quan hệ hết thì server trả 404, không dựa vào dữ liệu cũ.
  async function openDetail(memberId: string) {
    const loadNumber = ++latestDetail.current;
    // Xóa ngay chi tiết của học viên trước để không hiện nhầm lịch/gói.
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const [profile, bookings, memberships] = await Promise.all([
        traineesApi.detail(memberId), traineesApi.bookings(memberId), traineesApi.memberships(memberId),
      ]);
      if (loadNumber === latestDetail.current) setDetail({ detail: profile, bookings: bookings.items, memberships });
    } catch (error) {
      if (loadNumber !== latestDetail.current) return;
      setDetailError(error instanceof ApiError && error.status === 404
        ? 'Không tìm thấy học viên hoặc bạn không còn buổi tập với học viên này.'
        : errorMessage(error, 'Không tải được chi tiết học viên.'));
    } finally {
      if (loadNumber === latestDetail.current) setDetailLoading(false);
    }
  }

  return <>
    <form onSubmit={search} className="trainees-search">
      <label htmlFor="trainee-search">Tìm học viên</label>
      <input id="trainee-search" value={searchText} maxLength={120} onChange={event => setSearchText(event.target.value)} />
      <button type="submit">Tìm</button>
    </form>

    <section aria-labelledby="trainee-list-title">
      <h3 id="trainee-list-title">Danh sách học viên</h3>
      {listError && <div role="alert">
        <p>{listError}</p>
        <button type="button" onClick={() => setParams({ ...params })}>Thử lại</button>
      </div>}
      {!list && !listError && <p>Đang tải danh sách học viên...</p>}
      {/* US-30-TC04: account PT chưa có hồ sơ PT là trạng thái bình thường, không phải lỗi. */}
      {list && !list.profileLinked && <p>Tài khoản của bạn chưa được liên kết hồ sơ PT nên chưa có học viên.</p>}
      {list && list.profileLinked && list.items.length === 0 && <p>Danh sách học viên trống</p>}
      {list?.items.map(item => <article key={item.memberId} aria-label={item.fullName}>
        {/* US-30-TC08: tên hiện như chữ thường (React tự thoát HTML). */}
        <p><strong>{item.fullName}</strong></p>
        <p>{item.memberCode}</p>
        <p>Số buổi với tôi: {item.relatedBookingCount}</p>
        <p>{item.nextBookingAt ? `Buổi sắp tới: ${formatAsOf(item.nextBookingAt)}` : 'Chưa có buổi sắp tới'}</p>
        <button type="button" onClick={() => void openDetail(item.memberId)}>Xem chi tiết</button>
      </article>)}
      {list && list.page > 1 && <button type="button" onClick={() => setParams({ ...params, page: params.page - 1 })}>Trang trước</button>}
      {list && list.totalPages > list.page && <button type="button" onClick={() => setParams({ ...params, page: params.page + 1 })}>Trang sau</button>}
    </section>

    {detailLoading && <p>Đang tải chi tiết học viên...</p>}
    {detailError && <p role="alert">{detailError}</p>}
    {detail && <TraineeDetailView data={detail} />}
  </>;
}

// Chi tiết một học viên: hồ sơ tối thiểu, lịch với chính PT và gói liên quan. Chỉ hiển thị, không có nút ghi.
function TraineeDetailView({ data }: { data: DetailData }) {
  return <section aria-labelledby="trainee-detail-title">
    <h3 id="trainee-detail-title">Chi tiết học viên</h3>
    <p><strong>{data.detail.fullName}</strong></p>
    <p>{data.detail.memberCode}</p>

    <section aria-labelledby="trainee-schedule-title">
      <h4 id="trainee-schedule-title">Lịch với tôi</h4>
      <p>Tuần hiện tại.</p>
      {data.bookings.length === 0 && <p>Không có buổi nào trong tuần này.</p>}
      {data.bookings.map(booking => <article key={booking.id}>
        {/* Giờ theo giờ Việt Nam: "09:00–10:00 25/11/2026". */}
        <p>{formatRange(booking.startAt, booking.endAt)} {formatDate(booking.startAt)}</p>
        <p>{booking.location}</p>
        <p>{STATUS_LABELS[booking.status]}</p>
      </article>)}
    </section>

    <section aria-labelledby="trainee-packs-title">
      <h4 id="trainee-packs-title">Gói liên quan</h4>
      <p>Cập nhật lúc {formatAsOf(data.memberships.asOf)}</p>
      {data.memberships.items.length === 0 && <p>Không có gói liên quan.</p>}
      {/* US-30-TC10: mỗi gói một thẻ theo thứ tự server trả, số liệu riêng từng gói, không cộng gói cũ vào gói mới. */}
      {data.memberships.items.map(pack => <article key={pack.id}>
        <p>Gói {pack.kind ?? ''} · {formatDay(pack.startDate)} – {formatDay(pack.endDate)}</p>
        <p>{MEMBERSHIP_STATUS_LABELS[pack.storedStatus]}</p>
        <p>Tổng: {pack.quota} · Đã dùng: {pack.sessionsUsed} · Đang giữ chỗ: {pack.reserved} · Còn lại: {pack.available}</p>
        {pack.quotaInvalid && <p>Số liệu buổi của gói này bất thường, cần nhân viên kiểm tra lại.</p>}
      </article>)}
    </section>
  </section>;
}
