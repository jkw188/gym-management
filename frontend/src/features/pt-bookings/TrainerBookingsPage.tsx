// Tầng giao diện – trang (US-64 bước 4): trang /trainer/bookings – PT xem buổi dạy theo ngày và xác nhận buổi đã dạy.
// Nút "Xác nhận đã dạy" chỉ hiện theo permittedActions của server; giờ, quyền và quota do server kiểm, trang không tự tính.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { formatAsOf, formatDate, formatRange, todayInVietnam } from './pt-booking-format';
import { ptBookingsApi, type PtBookingStatus, type TrainerBooking } from './pt-bookings.api';

// US-64-TC15: nhãn trạng thái của trang PT (spec dùng "hoàn tất" cho buổi PT đã xác nhận).
const TRAINER_STATUS_LABELS: Record<PtBookingStatus, string> = { BOOKED: 'Đã đặt', COMPLETED: 'Đã hoàn tất', CANCELLED: 'Đã hủy' };

// Giờ buổi đầy đủ theo giờ VN: "09:00–10:00 25/11/2026".
const sessionTime = (booking: TrainerBooking) => `${formatRange(booking.startAt, booking.endAt)} ${formatDate(booking.startAt)}`;
const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);

// Chỉ một thông báo kết quả tại một thời điểm: thành công (role="status") hoặc lỗi (role="alert").
type Notice = { kind: 'success' | 'error'; text: string } | null;

export function TrainerBookingsPage() {
  // Mặc định xem hôm nay theo giờ VN.
  const [fromDate, setFromDate] = useState(todayInVietnam);
  const [toDate, setToDate] = useState(todayInVietnam);
  const [items, setItems] = useState<TrainerBooking[] | null>(null);
  const [loadError, setLoadError] = useState('');

  // Buổi đang mở bảng xác nhận, trạng thái gửi và thông báo kết quả.
  const [confirming, setConfirming] = useState<TrainerBooking | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const submittingNow = useRef(false);
  // US-64-TC15 (mất response giữ key): bấm lại cùng buổi + version → dùng LẠI key cũ; thành công hoặc 409 → bỏ key.
  const pendingKey = useRef<{ payload: string; key: string } | null>(null);
  // Kết quả tải cũ về muộn (đã đổi ngày) thì bỏ qua.
  const latestLoad = useRef(0);

  // US-64-TC15: GET /me/trainer-bookings theo hai ngày đang chọn.
  const load = useCallback(async () => {
    const loadNumber = ++latestLoad.current;
    setLoadError('');
    try {
      const page = await ptBookingsApi.listTrainerBookings(fromDate, toDate);
      if (loadNumber === latestLoad.current) setItems(page.items);
    } catch (error) {
      if (loadNumber === latestLoad.current) setLoadError(errorMessage(error, 'Không tải được danh sách buổi dạy.'));
    }
  }, [fromDate, toDate]);

  useEffect(() => { void load(); }, [load]);

  function openConfirm(booking: TrainerBooking) {
    setNotice(null);
    setConfirming(booking);
  }

  // US-64-TC15: gửi xác nhận cho buổi đang mở bảng xác nhận.
  async function submitComplete() {
    if (!confirming || submittingNow.current) return;
    submittingNow.current = true;
    setSubmitting(true);
    setNotice(null);

    const payload = JSON.stringify({ id: confirming.id, version: confirming.version });
    if (pendingKey.current?.payload !== payload) pendingKey.current = { payload, key: crypto.randomUUID() };

    try {
      await ptBookingsApi.completeBooking(confirming.id, confirming.version, pendingKey.current.key);
      pendingKey.current = null;
      setConfirming(null);
      setNotice({ kind: 'success', text: `Đã xác nhận buổi dạy của ${confirming.memberName}.` });
      // Thành công: tải lại từ server để thấy trạng thái và giờ xác nhận mới.
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Chưa tới giờ, đã hoàn tất, đã hủy hoặc version cũ: tải lại để thấy dữ liệu mới; lần xác nhận sau là ý định mới.
        pendingKey.current = null;
        setConfirming(null);
        setNotice({ kind: 'error', text: `${errorMessage(error, 'Không xác nhận được buổi này.')} Danh sách đã được tải lại, vui lòng kiểm tra lại.` });
        await load();
      } else {
        // Mất phản hồi/503: chưa biết kết quả. Giữ bảng xác nhận và key, KHÔNG tự gửi lại.
        setNotice({ kind: 'error', text: `${errorMessage(error, 'Không gửi được yêu cầu xác nhận.')} Bấm "Xác nhận" để thử lại.` });
      }
    } finally {
      submittingNow.current = false;
      setSubmitting(false);
    }
  }

  return <section className="auth-card pt-bookings">
    <h2>Buổi dạy của tôi</h2>

    <div className="pt-filter">
      <label htmlFor="trainer-from">Từ ngày</label>
      <input id="trainer-from" type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} />
      <label htmlFor="trainer-to">Đến ngày</label>
      <input id="trainer-to" type="date" value={toDate} onChange={event => setToDate(event.target.value)} />
    </div>

    {notice?.kind === 'success' && <p role="status">{notice.text}</p>}
    {notice?.kind === 'error' && <p role="alert">{notice.text}</p>}

    {confirming && <section aria-labelledby="trainer-confirm-title" className="pt-confirm">
      <h3 id="trainer-confirm-title">Xác nhận buổi đã dạy</h3>
      <p>Hội viên: {confirming.memberName}</p>
      <p>Giờ buổi: {sessionTime(confirming)}</p>
      <p>Xác nhận sẽ trừ 1 buổi trong gói PT của hội viên. Chỉ xác nhận khi buổi đã thực sự diễn ra.</p>
      <button type="button" onClick={() => void submitComplete()} disabled={submitting}>Xác nhận</button>
      <button type="button" onClick={() => setConfirming(null)} disabled={submitting}>Đóng</button>
    </section>}

    <section aria-labelledby="trainer-list-title">
      <h3 id="trainer-list-title">Danh sách buổi dạy</h3>
      {loadError && <p role="alert">{loadError}</p>}
      {items !== null && items.length === 0 && <p>Chưa có buổi dạy trong khoảng ngày này.</p>}
      {items?.map(booking => <article key={booking.id}>
        <p><strong>{booking.memberName}</strong></p>
        <p>{sessionTime(booking)}</p>
        <p>{TRAINER_STATUS_LABELS[booking.status]}</p>
        {/* US-64-TC15: buổi hoàn tất muộn hiện giờ xác nhận riêng, tách khỏi giờ buổi. */}
        {booking.status === 'COMPLETED' && booking.completedAt && <p>Xác nhận lúc: {formatAsOf(booking.completedAt)}</p>}
        {booking.permittedActions.includes('COMPLETE') &&
          <button type="button" onClick={() => openConfirm(booking)}>Xác nhận đã dạy</button>}
      </article>)}
    </section>
  </section>;
}
