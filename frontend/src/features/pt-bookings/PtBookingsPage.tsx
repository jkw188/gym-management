// Tầng giao diện – trang (US-27 bước 3, US-28 bước 4, US-29 bước 3): trang /member/pt-bookings – lịch PT riêng của Member, chọn PT/ngày/gói
// để xem slot trống và đặt slot sau bảng xác nhận; tự hủy buổi BOOKED khi server báo còn hạn (US-29).
// Quota, asOf, bookable, cancelAllowed lấy nguyên từ server, React không tự tính (US-27-TC12, US-29-TC02).
// US-65 bước 3: nút "Đánh giá"/"Xem đánh giá" theo reviewState của server; form đánh giá nằm ở PtReviewPanel.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { MyMembership } from '../memberships/memberships.api';
import { useAccountId } from '../notifications/inbox-signals';
import {
  isValidCancelReason, ptBookingsApi, type BookingFilter, type CancelBookingInput, type CreateBookingInput, type MyPtBooking,
  type PtAvailability, type PtBookingStatus, type PtSlot, type PtTrainer, type SlotReason,
} from './pt-bookings.api';
import { formatAsOf, formatDate, formatRange, STATUS_LABELS } from './pt-booking-format';
import { Icon } from '../../components/Icon';
import { PtReviewPanel, type ReviewMode } from './PtReviewPanel';

// US-27-TC12: giải thích vì sao slot chưa đặt được.
const REASON_LABELS: Record<SlotReason, string> = {
  MEMBERSHIP_REQUIRED: 'Chọn gói PT để đặt',
  QUOTA_EXHAUSTED: 'Gói đã hết số buổi',
  MEMBERSHIP_NOT_ELIGIBLE: 'Gói không dùng được cho buổi này',
};

const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);

// US-28-TC05–TC07: lý do server từ chối (409); không nêu ai đang chiếm lịch.
const CONFLICT_LABELS: Record<string, string> = {
  SLOT_UNAVAILABLE: 'Giờ này vừa có người đặt hoặc PT bận',
  MEMBER_TIME_CONFLICT: 'Bạn đã có buổi tập khác trùng giờ này',
  QUOTA_EXHAUSTED: 'Gói đã hết số buổi có thể đặt',
  SHIFT_UNAVAILABLE: 'Ca của PT không còn nhận đặt lịch',
  TRAINER_UNAVAILABLE: 'PT hiện không nhận lịch',
  MEMBERSHIP_NOT_ELIGIBLE: 'Gói không dùng được cho buổi này',
};

// US-29-F01: hạn tự hủy = giờ bắt đầu − 2 giờ, hiển thị giờ VN, ví dụ "07:00 25/11/2026".
// Chỉ để hiển thị; được hủy hay không do cancelAllowed của server quyết định.
const CANCEL_LEAD_MS = 2 * 60 * 60 * 1000;
const formatCancelDeadline = (startAt: string) => formatAsOf(new Date(Date.parse(startAt) - CANCEL_LEAD_MS).toISOString());

// US-29-TC02, TC04: thông báo khi server từ chối hủy (409).
const CANCEL_CONFLICT_LABELS: Record<string, string> = {
  CANCELLATION_WINDOW_CLOSED: 'Đã quá hạn tự hủy (trước giờ tập 2 giờ). Vui lòng liên hệ quầy để được hỗ trợ.',
  VERSION_CONFLICT: 'Lịch tập vừa thay đổi. Lịch đã được tải lại, vui lòng kiểm tra rồi hủy lại nếu cần.',
  INVALID_BOOKING_STATE: 'Buổi này không còn ở trạng thái hủy được. Lịch đã được tải lại.',
};

// ---------- Vùng "Lịch của tôi" ----------

function BookingCard({ booking, onCancel, onReview }: {
  booking: MyPtBooking;
  onCancel: (booking: MyPtBooking) => void;
  onReview: (booking: MyPtBooking, mode: ReviewMode) => void;
}) {
  return <article aria-label={`Buổi PT ${formatDate(booking.startAt)} ${formatRange(booking.startAt, booking.endAt)}`}>
    <p><strong>{booking.trainerName}</strong> · <span>{STATUS_LABELS[booking.status]}</span></p>
    <p>{formatDate(booking.startAt)} · {formatRange(booking.startAt, booking.endAt)}</p>
    <p>{booking.location}</p>
    {/* US-29-TC01, TC02: chỉ buổi BOOKED mới nói tới hủy. cancelAllowed lấy từ server, không tự tính lại bằng đồng hồ máy. */}
    {booking.status === 'BOOKED' && (booking.cancelAllowed
      ? <p>Hạn hủy: {formatCancelDeadline(booking.startAt)}{' '}
        <button type="button" onClick={() => onCancel(booking)}>Hủy lịch</button></p>
      : <p>Đã quá hạn tự hủy. Vui lòng liên hệ quầy để được hỗ trợ.</p>)}
    {/* US-65-TC04, TC07: nút đánh giá theo reviewState của server; không tự suy từ status hay gói còn hạn. */}
    {booking.reviewState === 'ELIGIBLE' && <p><button type="button" onClick={() => onReview(booking, 'create')}>Đánh giá</button></p>}
    {booking.reviewState === 'SUBMITTED' && <p><button type="button" onClick={() => onReview(booking, 'view')}>Xem đánh giá</button></p>}
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

  // US-28: slot đang xác nhận, trạng thái gửi, thông báo kết quả.
  const [confirmSlot, setConfirmSlot] = useState<PtSlot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [bookSuccess, setBookSuccess] = useState('');
  const [bookError, setBookError] = useState('');
  // US-28-TC10: chặn bấm kép ngay lập tức (state của React chỉ cập nhật ở lần render sau).
  const submittingNow = useRef(false);
  // US-28-TC10: Idempotency-Key gắn với đúng dữ liệu gửi (payload). Mất phản hồi/503 rồi bấm lại cùng slot → dùng LẠI key cũ;
  // đặt xong, bị 409 hoặc chọn slot khác là ý định mới → key mới.
  const pendingKey = useRef<{ payload: string; key: string } | null>(null);

  // US-29: buổi đang xác nhận hủy, lý do Member nhập, trạng thái gửi và kết quả (giữ chỗ riêng với luồng đặt lịch).
  const [cancelTarget, setCancelTarget] = useState<MyPtBooking | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [cancelSuccess, setCancelSuccess] = useState('');
  const [cancelError, setCancelError] = useState('');
  const cancellingNow = useRef(false);
  // US-29-TC12: giống US-28 – mất phản hồi/503 rồi bấm lại cùng dữ liệu thì dùng LẠI key cũ; xong hoặc bị 409 thì bỏ key.
  const pendingCancelKey = useRef<{ payload: string; key: string } | null>(null);

  // US-65: buổi đang mở đánh giá và chế độ (gửi mới / xem lại); chi tiết nằm trong PtReviewPanel.
  const [reviewTarget, setReviewTarget] = useState<{ booking: MyPtBooking; mode: ReviewMode } | null>(null);

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
  // US-28: đổi PT, ngày hoặc gói thì slot đang xác nhận không còn đúng lựa chọn → đóng bảng xác nhận.
  useEffect(() => { setConfirmSlot(null); }, [trainerId, day, membershipId]);

  // Spec mục "Giao diện": sau đặt/hủy (US-28/29) tải lại lịch, số buổi (quota) và giờ trống; Member cũng bấm được để xem số mới nhất.
  async function refreshAll() {
    await loadBookings();
    await loadBase();
    await loadAvailability();
  }

  // US-28-TC01: bấm slot chỉ mở bảng xác nhận, chưa gửi gì.
  function openConfirm(slot: PtSlot) {
    setBookSuccess('');
    setBookError('');
    setConfirmSlot(slot);
  }

  // US-28-TC01, TC05, TC10: gửi đặt lịch cho slot đang xác nhận.
  async function submitBooking() {
    if (!confirmSlot || submittingNow.current) return;
    submittingNow.current = true;
    setSubmitting(true);
    setBookSuccess('');
    setBookError('');

    // startAt lấy nguyên từ slot server trả; không gửi endAt/memberId/location.
    const input: CreateBookingInput = { membershipId, trainerId, shiftId: confirmSlot.shiftId, startAt: confirmSlot.startAt };
    const payload = JSON.stringify(input);
    if (pendingKey.current?.payload !== payload) pendingKey.current = { payload, key: crypto.randomUUID() };

    try {
      await ptBookingsApi.createBooking(input, pendingKey.current.key);
      // Thành công: ý định đã xong nên bỏ key; quota/giờ trống hiện theo số server mới sau khi tải lại.
      pendingKey.current = null;
      setConfirmSlot(null);
      setBookSuccess(`Đã đặt lịch ${formatRange(input.startAt, confirmSlot.endAt)} ngày ${formatDate(input.startAt)}.`);
      await refreshAll();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // US-28-TC05: xung đột → đóng xác nhận, tải lại giờ và quota, yêu cầu chọn lại; không tự đổi PT hay slot.
        pendingKey.current = null;
        setConfirmSlot(null);
        const reason = (error.code && CONFLICT_LABELS[error.code]) || 'Không đặt được giờ này';
        setBookError(`${reason}. Giờ trống và số buổi đã được tải lại, vui lòng chọn lại.`);
        await refreshAll();
      } else {
        // US-28-TC10: mất phản hồi hoặc 503 → chưa biết kết quả: giữ bảng xác nhận và key, KHÔNG tự gửi lại.
        setBookError(`${errorMessage(error, 'Không gửi được yêu cầu đặt lịch.')} Bấm "Xác nhận đặt" để thử lại.`);
      }
    } finally {
      submittingNow.current = false;
      setSubmitting(false);
    }
  }

  // US-29-TC01: bấm "Hủy lịch" chỉ mở bảng xác nhận, chưa gửi gì.
  function openCancel(booking: MyPtBooking) {
    setCancelSuccess('');
    setCancelError('');
    setCancelReason('');
    setCancelTarget(booking);
  }

  // US-29-TC01, TC02, TC04, TC12, TC13: gửi hủy buổi đang xác nhận.
  async function submitCancel() {
    if (!cancelTarget || cancellingNow.current || !isValidCancelReason(cancelReason)) return;
    cancellingNow.current = true;
    setCancelling(true);
    setCancelSuccess('');
    setCancelError('');

    // Body CHỈ {version, reason}: version của buổi đang hiện, lý do đã bỏ khoảng trắng hai đầu.
    const input: CancelBookingInput = { version: cancelTarget.version, reason: cancelReason.trim() };
    const payload = JSON.stringify({ id: cancelTarget.id, ...input });
    if (pendingCancelKey.current?.payload !== payload) pendingCancelKey.current = { payload, key: crypto.randomUUID() };

    try {
      await ptBookingsApi.cancelOwnBooking(cancelTarget.id, input, pendingCancelKey.current.key);
      // Thành công: bỏ key, đóng bảng xác nhận; trạng thái thẻ, quota và giờ trống hiện theo số server sau khi tải lại.
      pendingCancelKey.current = null;
      setCancelTarget(null);
      setCancelSuccess(`Đã hủy lịch ${formatRange(cancelTarget.startAt, cancelTarget.endAt)} ngày ${formatDate(cancelTarget.startAt)}.`);
      await refreshAll();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // US-29-TC02, TC04: server từ chối → đóng xác nhận, tải lại lịch (thẻ vẫn còn, theo dữ liệu mới); lần hủy sau là ý định mới.
        pendingCancelKey.current = null;
        setCancelTarget(null);
        setCancelError((error.code && CANCEL_CONFLICT_LABELS[error.code]) || 'Không hủy được buổi này. Lịch đã được tải lại.');
        await refreshAll();
      } else {
        // US-29-TC12: mất phản hồi hoặc 503 → chưa biết kết quả: giữ bảng xác nhận, lý do và key, KHÔNG tự gửi lại.
        setCancelError(`${errorMessage(error, 'Không gửi được yêu cầu hủy lịch.')} Bấm "Xác nhận hủy" để thử lại.`);
      }
    } finally {
      cancellingNow.current = false;
      setCancelling(false);
    }
  }

  // Đổi bộ lọc thì quay về trang 1.
  function changeFilter(change: Partial<BookingFilter>) {
    setFilter(current => ({ ...current, ...change, page: 1 }));
  }

  // US-27-TC07: chưa liên kết hồ sơ là trạng thái bình thường, không phải lỗi.
  const notLinked = bookings?.memberLinked === false || plans?.memberLinked === false;
  const selectedPlan = plans?.items.find(item => item.id === membershipId);
  const selectedTrainer = trainers.find(trainer => trainer.id === trainerId);

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
        ? <div role="alert"><p>{bookingsError}</p><button type="button" onClick={() => void loadBookings()}><Icon name="retry" label="Thử lại" /></button></div>
        : !bookings ? <p>Đang tải lịch…</p>
          : bookings.memberLinked && bookings.items.length === 0 ? <p>Không có buổi PT nào trong khoảng này.</p>
            : <>
              {bookings.items.map(item => <BookingCard key={item.id} booking={item} onCancel={openCancel}
                onReview={(booking, mode) => setReviewTarget({ booking, mode })} />)}
              {/* Lịch có phân trang: chỉ chuyển trang, không dùng số buổi đang thấy để suy ra quota. */}
              {bookings.totalPages > 1 && <p>
                <button type="button" disabled={filter.page <= 1}
                  onClick={() => setFilter(current => ({ ...current, page: current.page - 1 }))}><Icon name="prev" label="Trang trước" /></button>
                {' '}Trang {filter.page}/{bookings.totalPages} ({bookings.total} buổi){' '}
                <button type="button" disabled={filter.page >= bookings.totalPages}
                  onClick={() => setFilter(current => ({ ...current, page: current.page + 1 }))}><Icon name="next" label="Trang sau" /></button>
              </p>}
            </>}

      {/* US-29-TC01: xác nhận hủy – PT, thời gian buổi và hạn hủy (giờ VN), lý do bắt buộc 10–500 ký tự.
          Thời gian buổi và hạn hủy chung một dòng để mỗi mốc ngày chỉ xuất hiện một lần. */}
      {cancelTarget && <section aria-labelledby="pt-confirm-cancel">
        <h4 id="pt-confirm-cancel">Xác nhận hủy lịch</h4>
        <ul>
          <li>PT: {cancelTarget.trainerName}</li>
          <li>Thời gian: {formatRange(cancelTarget.startAt, cancelTarget.endAt)} ngày {formatDate(cancelTarget.startAt)} · Hạn hủy: {formatCancelDeadline(cancelTarget.startAt)}</li>
        </ul>
        <label>Lý do hủy <textarea value={cancelReason} disabled={cancelling} onChange={event => setCancelReason(event.target.value)} /></label>
        <p className="hint">Lý do dài từ 10 đến 500 ký tự.</p>
        {/* US-29-TC06: lý do không hợp lệ hoặc đang gửi thì khóa nút (không gửi kép). */}
        <button type="button" disabled={cancelling || !isValidCancelReason(cancelReason)} onClick={() => void submitCancel()}>Xác nhận hủy</button>
        {' '}<button type="button" disabled={cancelling} onClick={() => setCancelTarget(null)}><Icon name="close" label="Đóng" /></button>
      </section>}
      {cancelSuccess && <p role="status">{cancelSuccess}</p>}
      {cancelError && <p role="alert">{cancelError}</p>}

      {/* US-65: gửi hoặc xem đánh giá. key đổi theo buổi và chế độ → mỗi lần mở là form mới. */}
      {reviewTarget && <PtReviewPanel key={`${reviewTarget.booking.id}-${reviewTarget.mode}`} booking={reviewTarget.booking}
        mode={reviewTarget.mode} onReload={loadBookings} onClose={() => setReviewTarget(null)} />}
    </section>

    <section aria-labelledby="pt-book-panel">
      <h3 id="pt-book-panel">Đặt lịch PT</h3>
      {baseError
        ? <div role="alert"><p>{baseError}</p><button type="button" onClick={() => void loadBase()}><Icon name="retry" label="Thử lại" /></button></div>
        : <>
          {/* US-28-TC10: đang gửi đặt lịch thì khóa PT/ngày/gói và các slot, để bảng xác nhận và key giữ đúng dữ liệu đã gửi;
              lỗi mạng/503 thì Member vẫn bấm lại "Xác nhận đặt" với đúng key cũ. */}
          <label>Chọn PT <select value={trainerId} disabled={submitting} onChange={event => setTrainerId(event.target.value)}>
            <option value="">-- Chọn PT --</option>
            {trainers.map(trainer => <option key={trainer.id} value={trainer.id}>{trainer.displayName}</option>)}
          </select></label>
          <label>Ngày <input type="date" value={day} disabled={submitting} onChange={event => setDay(event.target.value)} /></label>
          <label>Gói PT <select value={membershipId} disabled={submitting} onChange={event => setMembershipId(event.target.value)}>
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
            <button type="button" onClick={() => void loadAvailability()}><Icon name="retry" label="Thử lại" /></button></div>}
          {availability && <div className="slots">
            {/* US-27-TC09: giờ trống chỉ để tham khảo, server kiểm lại khi đặt. */}
            <p>Giờ trống (cập nhật lúc {formatAsOf(availability.asOf)}). Xem giờ không giữ chỗ.</p>
            {availability.slots.length === 0 ? <p>PT không có giờ trống trong ngày này.</p>
              : <ul>{availability.slots.map(slot => <li key={slot.startAt}>
                {/* US-27-TC12: slot bookable=false bị khóa và có chữ giải thích. US-28: bấm slot mở bảng xác nhận. */}
                <button type="button" disabled={!slot.bookable || submitting} onClick={() => openConfirm(slot)}>{formatRange(slot.startAt, slot.endAt)}</button>
                {' '}{slot.location}
                {!slot.bookable && slot.reason && <span> – {REASON_LABELS[slot.reason]}</span>}
              </li>)}</ul>}
          </div>}

          {/* US-28-TC01: xác nhận PT, ngày, giờ VN, địa điểm, gói và số buổi còn (số server, không trừ trước khi server commit). */}
          {confirmSlot && <section aria-labelledby="pt-confirm-booking">
            <h4 id="pt-confirm-booking">Xác nhận đặt lịch</h4>
            <ul>
              <li>PT: {selectedTrainer?.displayName}</li>
              <li>Ngày: {formatDate(confirmSlot.startAt)}</li>
              <li>Giờ: {formatRange(confirmSlot.startAt, confirmSlot.endAt)}</li>
              <li>Địa điểm: {confirmSlot.location}</li>
              <li>Gói: {selectedPlan?.planName}</li>
              <li>Còn đặt được: {selectedPlan?.sessionsAvailable} buổi</li>
            </ul>
            {/* US-28-TC10: đang gửi thì khóa nút để không gửi kép. */}
            <button type="button" disabled={submitting} onClick={() => void submitBooking()}>Xác nhận đặt</button>
            {' '}<button type="button" disabled={submitting} onClick={() => setConfirmSlot(null)}><Icon name="close" label="Đóng" /></button>
          </section>}
          {bookSuccess && <p role="status">{bookSuccess}</p>}
          {bookError && <p role="alert">{bookError}</p>}

          <button type="button" onClick={() => void refreshAll()}><Icon name="retry" label="Tải lại lịch, giờ trống và số buổi" showLabel /></button>
        </>}
    </section>
  </section>;
}
