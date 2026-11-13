// Tầng giao diện – trang (US-24 bước 3, US-25 bước 3): trang /trainer/shifts cho PT xem lịch tuần, tạo/sửa ca nháp, công bố và hủy ca.
// Không tự kiểm luật ca (60 phút, nửa đêm, chồng ca, BOOKED): backend kiểm và trả lỗi, trang chỉ hiển thị dễ hiểu (US-24-F05, TC12).
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { addDays, dayLabel, mondayOf, previewSlots, toVietnamIso, vietnamDate, vietnamTime } from './shift-time';
import { shiftsApi, type Shift, type ShiftDetail, type ShiftPage, type ShiftStatus } from './shifts.api';
import { Icon } from '../../components/Icon';

// US-24-TC12: nhãn trạng thái rõ ràng cho PT.
const STATUS_LABELS: Record<ShiftStatus, string> = {
  SCHEDULED: 'Nháp',
  CONFIRMED: 'Công bố',
  COMPLETED: 'Hoàn tất',
  CANCELLED: 'Hủy',
};

// Số ca tối đa một lần tải (tối đa của API theo mục 2 spec). Mặc định server chỉ trả 20, không đủ cho một tuần.
const WEEK_LIMIT = 100;

// Dữ liệu form: shift = null là tạo mới, có shift là đang sửa ca đó.
interface ShiftForm { shift: Shift | null; date: string; from: string; to: string; location: string }

// Chỉ ca nháp chưa bắt đầu mới sửa được (US-24-F04); ca đã công bố muốn đổi phải hủy theo US-25.
const canEdit = (shift: Shift) => shift.status === 'SCHEDULED' && Date.parse(shift.startAt) > Date.now();

// US-25-TC01: chỉ ca nháp chưa bắt đầu mới công bố được (giống điều kiện sửa).
const canConfirm = canEdit;
// US-25-TC07: chỉ ca Nháp/Công bố chưa bắt đầu mới hủy được.
const canCancel = (shift: Shift) =>
  (shift.status === 'SCHEDULED' || shift.status === 'CONFIRMED') && Date.parse(shift.startAt) > Date.now();

// US-25-F02: lý do hủy sau trim dài 10–500 ký tự (server kiểm lại).
const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 500;

// US-25-TC12: PT không hủy lịch thay hội viên; hướng dẫn xử lý từng lịch theo US-29, không có "hủy tất cả".
const BOOKING_GUIDE = 'Bạn không thể hủy lịch thay hội viên. Hãy đề nghị Member tự hủy hoặc nhờ Staff/Admin hủy từng lịch, sau đó thử hủy ca lại.';

// US-25-TC03, TC10: ca đã bị đổi ở nơi khác, PT cần tải lại để thấy trạng thái/version mới.
const needsReload = (error: ApiError) => error.code === 'VERSION_CONFLICT' || error.code === 'INVALID_SHIFT_STATE';

// Chưa biết server đã ghi hay chưa nên giữ key để gửi lại đúng yêu cầu (EN-02, US-25-TC11):
// lỗi mạng (không có mã HTTP) hoặc server trả 503 OPERATION_OUTCOME_UNKNOWN. 409/400 là kết quả rõ ràng, bỏ key.
const isOutcomeUnknown = (error: ApiError) => error.status === undefined || error.code === 'OPERATION_OUTCOME_UNKNOWN';

const asApiError = (error: unknown, fallback: string) => (error instanceof ApiError ? error : new ApiError(fallback));

// Dữ liệu dialog hủy ca: detail = null khi đang tải chi tiết ca (bookedCount).
interface CancelState { shift: Shift; detail: ShiftDetail | null; loadError: string }

export function ShiftsPage() {
  // Thứ Hai của tuần đang xem, dạng YYYY-MM-DD (ngày Việt Nam).
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [data, setData] = useState<ShiftPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [form, setForm] = useState<ShiftForm | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  // Số thứ tự lần tải mới nhất: đổi tuần nhanh thì kết quả của tuần cũ về muộn bị bỏ qua.
  const latestLoad = useRef(0);
  // Idempotency-Key của ý định đang gửi: giữ nguyên khi gửi lại sau lỗi mạng, bỏ khi lưu xong hoặc sửa dữ liệu form (EN-02).
  const idempotencyKey = useRef<string | null>(null);
  // Chặn gửi kép ngay lập tức, kể cả khi state "submitting" chưa kịp cập nhật.
  const sending = useRef(false);

  // US-25: công bố ca. confirmingId = ca đang gửi; confirmError hiện ngoài lịch.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<ApiError | null>(null);
  // Key của lần công bố bị lỗi mạng, gắn với đúng ca và version: bấm lại cùng ca dùng lại key này.
  const confirmKey = useRef<{ shiftId: string; version: number; key: string } | null>(null);

  // US-25: dialog hủy ca.
  const [cancelState, setCancelState] = useState<CancelState | null>(null);
  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<ApiError | null>(null);
  const [reasonError, setReasonError] = useState('');
  const cancelKey = useRef<string | null>(null);

  const weekEnd = addDays(weekStart, 6);

  const loadList = useCallback(async () => {
    const loadNumber = ++latestLoad.current;
    setLoading(true);
    setListError('');
    try {
      // US-24-TC12: tải tuần đang xem từ thứ Hai đến Chủ nhật; luôn lấy dữ liệu mới từ server.
      const result = await shiftsApi.list({ fromDate: weekStart, toDate: weekEnd, limit: WEEK_LIMIT });
      if (loadNumber === latestLoad.current) setData(result);
    } catch (error) {
      if (loadNumber === latestLoad.current) setListError(error instanceof ApiError ? error.message : 'Không tải được lịch ca.');
    } finally {
      if (loadNumber === latestLoad.current) setLoading(false);
    }
  }, [weekStart, weekEnd]);

  useEffect(() => { void loadList(); }, [loadList]);

  function openForm(next: ShiftForm) {
    idempotencyKey.current = null;
    setFormError(null);
    setNotice('');
    setForm(next);
  }

  const openCreate = () => openForm({ shift: null, date: '', from: '', to: '', location: '' });

  // Điền sẵn ngày/giờ theo giờ Việt Nam của ca đang sửa.
  const openEdit = (shift: Shift) => openForm({
    shift, date: vietnamDate(new Date(shift.startAt)), from: vietnamTime(shift.startAt), to: vietnamTime(shift.endAt), location: shift.location,
  });

  // US-24-TC12: đóng form chưa gửi thì không tạo ca.
  function closeForm() {
    idempotencyKey.current = null;
    setFormError(null);
    setForm(null);
  }

  // Sửa dữ liệu là một ý định mới: lần gửi sau dùng key mới.
  function changeField(field: 'date' | 'from' | 'to' | 'location', value: string) {
    idempotencyKey.current = null;
    setForm(current => (current ? { ...current, [field]: value } : current));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    // US-24-TC12: đang gửi thì bỏ qua các lần bấm thêm.
    if (!form || sending.current) return;
    sending.current = true;
    setSubmitting(true);
    setFormError(null);
    // Giữ key cũ nếu đây là lần gửi lại sau lỗi mạng; chưa có thì tạo UUID mới.
    idempotencyKey.current ??= crypto.randomUUID();
    // Giờ kết thúc 00:00 là 00:00 ngày kế tiếp.
    const endDay = form.to === '00:00' ? addDays(form.date, 1) : form.date;
    const input = { startAt: toVietnamIso(form.date, form.from), endAt: toVietnamIso(endDay, form.to), location: form.location };
    try {
      if (form.shift) await shiftsApi.update(form.shift.id, { ...input, version: form.shift.version }, idempotencyKey.current);
      else await shiftsApi.create(input, idempotencyKey.current);
      // Thành công: đóng form, báo đã lưu (ca vẫn là nháp) và tải lại từ server.
      idempotencyKey.current = null;
      setForm(null);
      setNotice('Đã lưu ca nháp. Ca chưa mở đặt cho hội viên.');
      void loadList();
    } catch (error) {
      // Giữ dữ liệu form và key; không tự gửi lại.
      setFormError(error instanceof ApiError ? error : new ApiError('Không lưu được ca nháp.'));
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  }

  // US-24-TC12: VERSION_CONFLICT chỉ tải lại khi PT bấm, để không mất dữ liệu đang nhập ngoài ý muốn.
  function reloadAfterConflict() {
    closeForm();
    void loadList();
  }

  // ---------- US-25: công bố ca ----------
  async function confirmShift(shift: Shift) {
    // US-25-TC10: đang gửi thì bỏ qua các lần bấm thêm.
    if (sending.current) return;
    sending.current = true;
    setConfirmingId(shift.id);
    setConfirmError(null);
    setNotice('');
    // Gửi lại sau lỗi mạng (cùng ca, cùng version) thì dùng key cũ; còn lại tạo key mới.
    const previous = confirmKey.current;
    const key = previous && previous.shiftId === shift.id && previous.version === shift.version ? previous.key : crypto.randomUUID();
    confirmKey.current = { shiftId: shift.id, version: shift.version, key };
    try {
      await shiftsApi.confirm(shift.id, { version: shift.version }, key);
      confirmKey.current = null;
      // US-25-TC01, TC12: trạng thái mới đọc lại từ REST, không chờ realtime.
      setNotice('Đã công bố ca. Hội viên có thể đặt lịch trong ca này.');
      void loadList();
    } catch (error) {
      const apiError = asApiError(error, 'Không công bố được ca.');
      // Server đã trả lời rõ (409, 400…) thì yêu cầu này kết thúc, bỏ key; kết quả chưa rõ thì giữ key.
      if (!isOutcomeUnknown(apiError)) confirmKey.current = null;
      setConfirmError(apiError);
    } finally {
      sending.current = false;
      setConfirmingId(null);
    }
  }

  // US-25-TC03: chỉ tải lại khi PT bấm "Tải lại ca".
  function reloadAfterConfirmError() {
    setConfirmError(null);
    void loadList();
  }

  // ---------- US-25: hủy ca ----------
  // Mở dialog và tải chi tiết ca để biết bookedCount (chỉ là ảnh chụp, server kiểm lại khi hủy).
  async function openCancel(shift: Shift) {
    cancelKey.current = null;
    setReason('');
    setReasonError('');
    setCancelError(null);
    setNotice('');
    setCancelState({ shift, detail: null, loadError: '' });
    try {
      const detail = await shiftsApi.get(shift.id);
      setCancelState(current => (current?.shift.id === shift.id ? { ...current, detail } : current));
    } catch (error) {
      const message = asApiError(error, 'Không tải được thông tin ca.').message;
      setCancelState(current => (current?.shift.id === shift.id ? { ...current, loadError: message } : current));
    }
  }

  // US-25-TC04: đóng dialog chưa gửi thì không hủy ca.
  function closeCancel() {
    cancelKey.current = null;
    setCancelState(null);
  }

  // Sửa lý do là một ý định mới: lần gửi sau dùng key mới.
  function changeReason(value: string) {
    cancelKey.current = null;
    setReasonError('');
    setReason(value);
  }

  async function submitCancel(event: FormEvent) {
    event.preventDefault();
    if (!cancelState || sending.current) return;
    // US-25-TC04: lý do quá ngắn thì báo ngay, không gọi API.
    const trimmed = reason.trim();
    if (trimmed.length < MIN_REASON_LENGTH) {
      setReasonError(`Lý do hủy cần ít nhất ${MIN_REASON_LENGTH} ký tự.`);
      return;
    }
    sending.current = true;
    setCancelling(true);
    setCancelError(null);
    cancelKey.current ??= crypto.randomUUID();
    try {
      await shiftsApi.cancel(cancelState.shift.id, { version: cancelState.shift.version, reason: trimmed }, cancelKey.current);
      cancelKey.current = null;
      setCancelState(null);
      setNotice('Đã hủy ca.');
      void loadList();
    } catch (error) {
      const apiError = asApiError(error, 'Không hủy được ca.');
      if (!isOutcomeUnknown(apiError)) cancelKey.current = null;
      // Giữ dialog và lý do để PT đọc hướng dẫn hoặc gửi lại.
      setCancelError(apiError);
    } finally {
      sending.current = false;
      setCancelling(false);
    }
  }

  // US-25-TC10: ca đã đổi ở nơi khác → đóng dialog và tải lại khi PT bấm.
  function reloadAfterCancelError() {
    closeCancel();
    void loadList();
  }

  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const bookedCount = cancelState?.detail?.bookedCount ?? 0;
  const preview = form && form.date && form.from && form.to ? previewSlots(form.from, form.to) : null;

  return <section className="auth-card shifts-page">
    <h2>Ca làm việc</h2>
    {notice && <p role="status" className="user-notice">{notice}</p>}

    <div className="user-actions" role="group" aria-label="Chọn tuần">
      <button type="button" className="secondary" onClick={() => setWeekStart(addDays(weekStart, -7))}><Icon name="prev" label="Tuần trước" /></button>
      <span>{dayLabel(weekStart, 0)} – {dayLabel(weekEnd, 6)}</span>
      <button type="button" className="secondary" onClick={() => setWeekStart(addDays(weekStart, 7))}><Icon name="next" label="Tuần sau" /></button>
    </div>

    {loading && <p>Đang tải lịch ca…</p>}
    {listError && <div className="form-error" role="alert"><p>{listError}</p>
      <button type="button" onClick={() => void loadList()}><Icon name="retry" label="Thử lại" /></button></div>}

    {/* US-24-TC02: account TRAINER chưa liên kết hồ sơ PT thì không cho thêm ca. */}
    {data && !data.profileLinked && <p>Tài khoản của bạn chưa có hồ sơ PT. Hãy liên hệ quản trị viên để được tạo hồ sơ trước khi khai báo ca.</p>}

    {data?.profileLinked && <>
      {/* Server còn ca chưa trả về (tuần quá 100 ca): báo rõ thay vì lặng lẽ thiếu ca trên lịch. */}
      {data.total > data.items.length && <p className="form-error">
        Tuần này có {data.total} ca nhưng lịch chỉ hiển thị {data.items.length} ca đầu tiên. Một số ca cuối tuần chưa được hiện.
      </p>}
      {!form && <button type="button" onClick={openCreate}>Thêm ca nháp</button>}

      {/* US-25-TC03, TC10: lỗi công bố ca; không tự tải lại hay tự gửi lại. */}
      {confirmError && <div className="form-error" role="alert">
        <p>{confirmError.message}</p>
        {isOutcomeUnknown(confirmError) && <p>Chưa xác nhận được kết quả. Bấm "Công bố ca" lần nữa để gửi lại đúng yêu cầu này.</p>}
        {needsReload(confirmError) && <>
          <p>Ca đã được thay đổi ở nơi khác. Tải lại để xem trạng thái mới nhất.</p>
          <button type="button" onClick={reloadAfterConfirmError}><Icon name="retry" label="Tải lại ca" showLabel /></button>
        </>}
      </div>}

      {/* US-25-TC04, TC12: dialog hủy ca có lý do và hướng dẫn khi ca còn lịch đặt. */}
      {cancelState && <div role="dialog" aria-modal="true" aria-labelledby="cancel-shift-title" className="auth-card">
        <h3 id="cancel-shift-title">Hủy ca</h3>
        <p>{vietnamDate(new Date(cancelState.shift.startAt))} · {vietnamTime(cancelState.shift.startAt)}–{vietnamTime(cancelState.shift.endAt)} · {cancelState.shift.location}</p>

        {!cancelState.detail && !cancelState.loadError && <p>Đang tải thông tin ca…</p>}
        {cancelState.loadError && <div className="form-error" role="alert"><p>{cancelState.loadError}</p>
          <button type="button" onClick={() => void openCancel(cancelState.shift)}><Icon name="retry" label="Thử lại" /></button></div>}

        {cancelState.detail && <form onSubmit={submitCancel} noValidate aria-busy={cancelling}>
          {/* US-25-TC12: còn lịch đặt thì không cho gửi, chỉ hướng dẫn xử lý từng lịch. */}
          {bookedCount > 0 && <div className="form-error">
            <p>Ca đang có {bookedCount} lịch đặt nên chưa hủy được.</p>
            <p>{BOOKING_GUIDE}</p>
          </div>}

          <label htmlFor="cancel-reason">Lý do hủy</label>
          <textarea id="cancel-reason" maxLength={MAX_REASON_LENGTH} value={reason} disabled={cancelling}
            onChange={event => changeReason(event.target.value)} />
          {reasonError && <p className="form-error" role="alert">{reasonError}</p>}

          {/* US-25-TC05, TC10: lỗi từ server khi hủy. */}
          {cancelError && <div className="form-error" role="alert">
            <p>{cancelError.message}</p>
            {cancelError.code === 'SHIFT_HAS_BOOKINGS' && <p>{BOOKING_GUIDE}</p>}
            {isOutcomeUnknown(cancelError) && <p>Chưa xác nhận được kết quả. Bấm "Xác nhận hủy ca" để gửi lại đúng yêu cầu này.</p>}
            {needsReload(cancelError) && <>
              <p>Ca đã được thay đổi ở nơi khác. Tải lại để xem trạng thái mới nhất.</p>
              <button type="button" onClick={reloadAfterCancelError}><Icon name="retry" label="Tải lại ca" showLabel /></button>
            </>}
          </div>}

          <div className="user-actions">
            <button type="submit" disabled={cancelling || bookedCount > 0}>{cancelling ? 'Đang hủy…' : 'Xác nhận hủy ca'}</button>
            <button type="button" className="secondary" onClick={closeCancel} disabled={cancelling}><Icon name="close" label="Đóng" /></button>
          </div>
        </form>}
      </div>}

      {form && <form onSubmit={submit} noValidate aria-busy={submitting} aria-label={form.shift ? 'Sửa ca nháp' : 'Thêm ca nháp'}>
        <h3>{form.shift ? 'Sửa ca nháp' : 'Thêm ca nháp'}</h3>
        <fieldset disabled={submitting}>
          <label htmlFor="shift-date">Ngày</label>
          <input id="shift-date" type="date" value={form.date} onChange={event => changeField('date', event.target.value)} />
          <label htmlFor="shift-from">Giờ bắt đầu</label>
          <input id="shift-from" type="time" value={form.from} onChange={event => changeField('from', event.target.value)} />
          <label htmlFor="shift-to">Giờ kết thúc</label>
          <input id="shift-to" type="time" value={form.to} onChange={event => changeField('to', event.target.value)} />
          <label htmlFor="shift-location">Địa điểm</label>
          <input id="shift-location" maxLength={120} value={form.location} onChange={event => changeField('location', event.target.value)} />
        </fieldset>

        {/* US-24-TC01, TC12: preview slot 60 phút; phần dư không mở đặt. */}
        {preview && <section aria-label="Xem trước slot">
          <h4>Xem trước slot</h4>
          {preview.slots.length > 0
            ? <ul>{preview.slots.map(slot => <li key={slot.from}>{slot.from}–{slot.to}</li>)}</ul>
            : <p>Ca chưa đủ 60 phút nên chưa có slot nào.</p>}
          {preview.remainderMinutes > 0 && <p>Dư {preview.remainderMinutes} phút cuối ca, phần này không mở đặt.</p>}
        </section>}

        {formError && <div className="form-error" role="alert">
          <p>{formError.message}</p>
          {formError.details && <ul>{formError.details.map(detail => <li key={detail.field}>{detail.message}</li>)}</ul>}
          {formError.code === 'SHIFT_OVERLAP' && <p>Hãy chọn khung giờ không trùng với ca khác của bạn.</p>}
          {/* Lỗi mạng: chưa chắc server đã lưu; bấm lưu lại sẽ gửi đúng key cũ nên không tạo trùng. */}
          {formError.status === undefined && <p>Chưa xác nhận được kết quả. Bấm "Lưu ca nháp" để gửi lại đúng yêu cầu này.</p>}
          {formError.code === 'VERSION_CONFLICT' && <>
            <p>Ca đã được thay đổi ở nơi khác. Tải lại để xem dữ liệu mới nhất.</p>
            <button type="button" onClick={reloadAfterConflict}><Icon name="retry" label="Tải lại ca" showLabel /></button>
          </>}
        </div>}

        <div className="user-actions">
          <button type="submit" disabled={submitting}>{submitting ? 'Đang lưu…' : 'Lưu ca nháp'}</button>
          <button type="button" className="secondary" onClick={closeForm} disabled={submitting}><Icon name="close" label="Đóng" /></button>
        </div>
      </form>}

      {/* US-24-TC12: lịch tuần dạng 7 cột Thứ Hai → Chủ nhật, mỗi ngày một vùng; giờ hiển thị theo Asia/Ho_Chi_Minh.
          Ca trong cột theo thứ tự server trả (startAt tăng dần). Màn hình hẹp thì cuộn ngang trong khung lịch. */}
      <div className="shift-week">
        {days.map((day, index) => {
          const items = data.items.filter(shift => vietnamDate(new Date(shift.startAt)) === day);
          return <section key={day} aria-label={dayLabel(day, index)} className="shift-day">
            <h3>{dayLabel(day, index)}</h3>
            {items.length === 0 ? <p className="shift-empty">Không có ca.</p> : <ul>
              {items.map(shift => <li key={shift.id} className={`shift-item shift-${shift.status.toLowerCase()}`}>
                <span className="shift-time">{vietnamTime(shift.startAt)}–{vietnamTime(shift.endAt)}</span>
                <span>{shift.location}</span>
                <strong>{STATUS_LABELS[shift.status]}</strong>
                <div className="shift-item-actions">
                  {canEdit(shift) && <button type="button" className="secondary" onClick={() => openEdit(shift)} disabled={Boolean(form)}>Sửa</button>}
                  {/* US-25-TC01, TC10: khóa nút khi đang công bố ca này. */}
                  {canConfirm(shift) && <button type="button" onClick={() => void confirmShift(shift)} disabled={confirmingId === shift.id}>
                    {confirmingId === shift.id ? 'Đang công bố…' : 'Công bố ca'}
                  </button>}
                  {canCancel(shift) && <button type="button" className="secondary" onClick={() => void openCancel(shift)}
                    disabled={Boolean(cancelState)}>Hủy ca</button>}
                </div>
              </li>)}
            </ul>}
          </section>;
        })}
      </div>
    </>}
  </section>;
}
