// Tầng giao diện – trang (US-27 bước 3): trang /member/pt-bookings – lịch PT riêng của Member và bước chọn PT/ngày/gói
// để xem slot trống. Chỉ đọc; quota, asOf, bookable lấy nguyên từ server, React không tự tính (US-27-TC12).
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { MyMembership } from '../memberships/memberships.api';
import { useAccountId } from '../notifications/inbox-signals';
import {
  ptBookingsApi, type BookingFilter, type MyPtBooking, type PtAvailability, type PtBookingStatus, type PtTrainer, type SlotReason,
} from './pt-bookings.api';

const STATUS_LABELS: Record<PtBookingStatus, string> = { BOOKED: 'Đã đặt', COMPLETED: 'Đã hoàn thành', CANCELLED: 'Đã hủy' };

// US-27-TC12: giải thích vì sao slot chưa đặt được.
const REASON_LABELS: Record<SlotReason, string> = {
  MEMBERSHIP_REQUIRED: 'Chọn gói PT để đặt',
  QUOTA_EXHAUSTED: 'Gói đã hết số buổi',
  MEMBERSHIP_NOT_ELIGIBLE: 'Gói không dùng được cho buổi này',
};

const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);

// US-27-TC11: mọi thời điểm hiển thị theo giờ Việt Nam, kể cả khi máy người dùng ở múi giờ khác.
const vnDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' });
const vnTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const formatDate = (iso: string) => vnDate.format(new Date(iso));                     // "25/11/2026"
const formatTime = (iso: string) => vnTime.format(new Date(iso));                     // "08:00"
const formatRange = (startAt: string, endAt: string) => `${formatTime(startAt)}–${formatTime(endAt)}`;
const formatAsOf = (iso: string) => `${formatTime(iso)} ${formatDate(iso)}`;          // "10:05 20/11/2026"

// ---------- Vùng "Lịch của tôi" ----------

function BookingCard({ booking }: { booking: MyPtBooking }) {
  return <article aria-label={`Buổi PT ${formatDate(booking.startAt)} ${formatRange(booking.startAt, booking.endAt)}`}>
    <p><strong>{booking.trainerName}</strong> · <span>{STATUS_LABELS[booking.status]}</span></p>
    <p>{formatDate(booking.startAt)} · {formatRange(booking.startAt, booking.endAt)}</p>
    <p>{booking.location}</p>
  </article>;
}

// ---------- Trang ----------

export function PtBookingsPage() {
  const accountId = useAccountId();

  // Lịch riêng và bộ lọc.
  const [filter, setFilter] = useState<BookingFilter>({ fromDate: '', toDate: '', status: '', page: 1 });
  const [bookings, setBookings] = useState<{ memberLinked: boolean; items: MyPtBooking[]; total: number; totalPages: number } | null>(null);
  const [bookingsError, setBookingsError] = useState('');

  // Danh mục PT và gói PT dùng được.
  const [trainers, setTrainers] = useState<PtTrainer[]>([]);
  const [plans, setPlans] = useState<{ memberLinked: boolean; asOf: string; items: MyMembership[] } | null>(null);
  const [baseError, setBaseError] = useState('');

  // Lựa chọn của Member và slot của lựa chọn đó.
  const [trainerId, setTrainerId] = useState('');
  const [day, setDay] = useState('');
  const [membershipId, setMembershipId] = useState('');
  const [availability, setAvailability] = useState<PtAvailability | null>(null);
  const [availabilityError, setAvailabilityError] = useState('');

  // Số thứ tự lần tải mới nhất: kết quả cũ về muộn (bộ lọc/lựa chọn đã đổi) thì bỏ qua.
  const latestBookings = useRef(0);
  const latestBase = useRef(0);
  const latestAvailability = useRef(0);

  const loadBookings = useCallback(async () => {
    if (!accountId) return;
    const loadNumber = ++latestBookings.current;
    setBookingsError('');
    try {
      const result = await ptBookingsApi.listBookings(filter);
      if (loadNumber === latestBookings.current) setBookings(result);
    } catch (error) {
      // US-27-TC12: lỗi mạng/server là lỗi, không hiện như "chưa liên kết" hay "không có buổi nào".
      if (loadNumber === latestBookings.current) setBookingsError(errorMessage(error, 'Không tải được lịch PT.'));
    }
  }, [accountId, filter]);

  const loadBase = useCallback(async () => {
    if (!accountId) return;
    const loadNumber = ++latestBase.current;
    setBaseError('');
    try {
      const [trainerPage, usablePlans] = await Promise.all([ptBookingsApi.listTrainers(), ptBookingsApi.listUsablePtMemberships()]);
      // Kết quả của lần tải cũ (ví dụ của account trước) về muộn thì bỏ qua, không hiện gói/số buổi của người khác.
      if (loadNumber !== latestBase.current) return;
      setTrainers(trainerPage.items);
      setPlans(usablePlans);
    } catch (error) {
      if (loadNumber === latestBase.current) setBaseError(errorMessage(error, 'Không tải được danh sách PT và gói tập.'));
    }
  }, [accountId]);

  const loadAvailability = useCallback(async () => {
    const loadNumber = ++latestAvailability.current;
    setAvailability(null);
    setAvailabilityError('');
    // Cần đủ PT và ngày mới hỏi server giờ trống.
    if (!trainerId || !day) return;
    try {
      const result = await ptBookingsApi.availability(trainerId, day, membershipId);
      if (loadNumber === latestAvailability.current) setAvailability(result);
    } catch (error) {
      if (loadNumber === latestAvailability.current) setAvailabilityError(errorMessage(error, 'Không tải được giờ trống của PT.'));
    }
  }, [trainerId, day, membershipId]);

  // Đổi account thì xóa dữ liệu của account trước.
  useEffect(() => {
    setBookings(null);
    setPlans(null);
    setTrainers([]);
    setTrainerId('');
    setMembershipId('');
  }, [accountId]);

  useEffect(() => { void loadBookings(); }, [loadBookings]);
  useEffect(() => { void loadBase(); }, [loadBase]);
  useEffect(() => { void loadAvailability(); }, [loadAvailability]);

  // Spec mục "Giao diện": sau đặt/hủy (US-28/29) tải lại lịch, số buổi (quota) và giờ trống; Member cũng bấm được để xem số mới nhất.
  async function refreshAll() {
    await loadBookings();
    await loadBase();
    await loadAvailability();
  }

  // Đổi bộ lọc thì quay về trang 1.
  function changeFilter(change: Partial<BookingFilter>) {
    setFilter(current => ({ ...current, ...change, page: 1 }));
  }

  // US-27-TC07: chưa liên kết hồ sơ là trạng thái bình thường, không phải lỗi.
  const notLinked = bookings?.memberLinked === false || plans?.memberLinked === false;
  const selectedPlan = plans?.items.find(item => item.id === membershipId);

  return <section className="auth-card pt-bookings">
    <h2>Lịch PT của tôi</h2>
    {notLinked && <p role="status">
      Tài khoản của bạn chưa được liên kết hồ sơ hội viên. Vui lòng liên hệ quầy lễ tân để được liên kết trước khi đặt lịch PT.
    </p>}

    <section aria-labelledby="pt-my-bookings">
      <h3 id="pt-my-bookings">Lịch của tôi</h3>
      <div className="filters">
        <label>Từ ngày <input type="date" value={filter.fromDate} onChange={event => changeFilter({ fromDate: event.target.value })} /></label>
        <label>Đến ngày <input type="date" value={filter.toDate} onChange={event => changeFilter({ toDate: event.target.value })} /></label>
        <label>Trạng thái <select value={filter.status} onChange={event => changeFilter({ status: event.target.value as PtBookingStatus | '' })}>
          <option value="">Tất cả</option>
          <option value="BOOKED">Đã đặt</option>
          <option value="COMPLETED">Đã hoàn thành</option>
          <option value="CANCELLED">Đã hủy</option>
        </select></label>
      </div>
      <p className="hint">Để trống ngày thì xem tuần hiện tại (từ thứ Hai).</p>
      {bookingsError
        ? <div role="alert"><p>{bookingsError}</p><button type="button" onClick={() => void loadBookings()}>Thử lại</button></div>
        : !bookings ? <p>Đang tải lịch…</p>
          : bookings.memberLinked && bookings.items.length === 0 ? <p>Không có buổi PT nào trong khoảng này.</p>
            : <>
              {bookings.items.map(item => <BookingCard key={item.id} booking={item} />)}
              {/* Lịch có phân trang: chỉ chuyển trang, không dùng số buổi đang thấy để suy ra quota. */}
              {bookings.totalPages > 1 && <p>
                <button type="button" disabled={filter.page <= 1}
                  onClick={() => setFilter(current => ({ ...current, page: current.page - 1 }))}>Trang trước</button>
                {' '}Trang {filter.page}/{bookings.totalPages} ({bookings.total} buổi){' '}
                <button type="button" disabled={filter.page >= bookings.totalPages}
                  onClick={() => setFilter(current => ({ ...current, page: current.page + 1 }))}>Trang sau</button>
              </p>}
            </>}
    </section>

    <section aria-labelledby="pt-book-panel">
      <h3 id="pt-book-panel">Đặt lịch PT</h3>
      {baseError
        ? <div role="alert"><p>{baseError}</p><button type="button" onClick={() => void loadBase()}>Thử lại</button></div>
        : <>
          <label>Chọn PT <select value={trainerId} onChange={event => setTrainerId(event.target.value)}>
            <option value="">-- Chọn PT --</option>
            {trainers.map(trainer => <option key={trainer.id} value={trainer.id}>{trainer.displayName}</option>)}
          </select></label>
          <label>Ngày <input type="date" value={day} onChange={event => setDay(event.target.value)} /></label>
          <label>Gói PT <select value={membershipId} onChange={event => setMembershipId(event.target.value)}>
            <option value="">-- Chưa chọn gói --</option>
            {plans?.items.map(plan => <option key={plan.id} value={plan.id}>{plan.planName}</option>)}
          </select></label>
          {plans && !notLinked && plans.items.length === 0 && <p>Bạn chưa có gói PT nào đang dùng được. Vui lòng liên hệ quầy để mua gói PT.</p>}

          {/* US-27-TC12: số buổi lấy nguyên từ server (US-17), không đếm từ lịch đang thấy vì lịch có phân trang. */}
          {selectedPlan && plans && <div className="quota">
            <ul>
              <li>Đã dùng: {selectedPlan.sessionsUsed}/{selectedPlan.sessionsQuota} buổi</li>
              <li>Đang giữ chỗ: {selectedPlan.sessionsReserved} buổi</li>
              <li>Còn đặt được: {selectedPlan.sessionsAvailable} buổi</li>
            </ul>
            <p>Cập nhật lúc {formatAsOf(plans.asOf)}</p>
          </div>}

          {availabilityError && <div role="alert"><p>{availabilityError}</p>
            <button type="button" onClick={() => void loadAvailability()}>Thử lại</button></div>}
          {availability && <div className="slots">
            {/* US-27-TC09: giờ trống chỉ để tham khảo, server kiểm lại khi đặt. */}
            <p>Giờ trống (cập nhật lúc {formatAsOf(availability.asOf)}). Xem giờ không giữ chỗ.</p>
            {availability.slots.length === 0 ? <p>PT không có giờ trống trong ngày này.</p>
              : <ul>{availability.slots.map(slot => <li key={slot.startAt}>
                {/* US-27-TC12: slot bookable=false bị khóa và có chữ giải thích. Bước 3 chưa đặt nên nút chưa làm gì. */}
                <button type="button" disabled={!slot.bookable}>{formatRange(slot.startAt, slot.endAt)}</button>
                {' '}{slot.location}
                {!slot.bookable && slot.reason && <span> – {REASON_LABELS[slot.reason]}</span>}
              </li>)}</ul>}
          </div>}
          <button type="button" onClick={() => void refreshAll()}>Tải lại lịch, giờ trống và số buổi</button>
        </>}
    </section>
  </section>;
}
