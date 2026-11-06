// Tầng giao diện – trang (US-24 bước 3): trang /trainer/shifts cho PT xem lịch tuần và tạo/sửa ca nháp của mình.
// Không tự kiểm luật ca (60 phút, nửa đêm, chồng ca): backend kiểm và trả lỗi, trang chỉ hiển thị dễ hiểu (US-24-F05, TC12).
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { addDays, dayLabel, mondayOf, previewSlots, toVietnamIso, vietnamDate, vietnamTime } from './shift-time';
import { shiftsApi, type Shift, type ShiftPage, type ShiftStatus } from './shifts.api';

// US-24-TC12: nhãn trạng thái rõ ràng cho PT.
const STATUS_LABELS: Record<ShiftStatus, string> = {
  SCHEDULED: 'Nháp',
  CONFIRMED: 'Công bố',
  COMPLETED: 'Hoàn tất',
  CANCELLED: 'Hủy',
};

// Dữ liệu form: shift = null là tạo mới, có shift là đang sửa ca đó.
interface ShiftForm { shift: Shift | null; date: string; from: string; to: string; location: string }

// Chỉ ca nháp chưa bắt đầu mới sửa được (US-24-F04); ca đã công bố muốn đổi phải hủy theo US-25.
const canEdit = (shift: Shift) => shift.status === 'SCHEDULED' && Date.parse(shift.startAt) > Date.now();

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

  const weekEnd = addDays(weekStart, 6);

  const loadList = useCallback(async () => {
    const loadNumber = ++latestLoad.current;
    setLoading(true);
    setListError('');
    try {
      // US-24-TC12: tải tuần đang xem từ thứ Hai đến Chủ nhật; luôn lấy dữ liệu mới từ server.
      const result = await shiftsApi.list({ fromDate: weekStart, toDate: weekEnd });
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

  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const preview = form && form.date && form.from && form.to ? previewSlots(form.from, form.to) : null;

  return <section className="auth-card shifts-page">
    <h2>Ca làm việc</h2>
    {notice && <p role="status" className="user-notice">{notice}</p>}

    <div className="user-actions" role="group" aria-label="Chọn tuần">
      <button type="button" className="secondary" onClick={() => setWeekStart(addDays(weekStart, -7))}>Tuần trước</button>
      <span>{dayLabel(weekStart, 0)} – {dayLabel(weekEnd, 6)}</span>
      <button type="button" className="secondary" onClick={() => setWeekStart(addDays(weekStart, 7))}>Tuần sau</button>
    </div>

    {loading && <p>Đang tải lịch ca…</p>}
    {listError && <div className="form-error" role="alert"><p>{listError}</p>
      <button type="button" onClick={() => void loadList()}>Thử lại</button></div>}

    {/* US-24-TC02: account TRAINER chưa liên kết hồ sơ PT thì không cho thêm ca. */}
    {data && !data.profileLinked && <p>Tài khoản của bạn chưa có hồ sơ PT. Hãy liên hệ quản trị viên để được tạo hồ sơ trước khi khai báo ca.</p>}

    {data?.profileLinked && <>
      {!form && <button type="button" onClick={openCreate}>Thêm ca nháp</button>}

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
            <button type="button" onClick={reloadAfterConflict}>Tải lại ca</button>
          </>}
        </div>}

        <div className="user-actions">
          <button type="submit" disabled={submitting}>{submitting ? 'Đang lưu…' : 'Lưu ca nháp'}</button>
          <button type="button" className="secondary" onClick={closeForm} disabled={submitting}>Đóng</button>
        </div>
      </form>}

      {/* US-24-TC12: lịch tuần, mỗi ngày một vùng; giờ hiển thị theo Asia/Ho_Chi_Minh. */}
      {days.map((day, index) => {
        const items = data.items.filter(shift => vietnamDate(new Date(shift.startAt)) === day);
        return <section key={day} aria-label={dayLabel(day, index)}>
          <h3>{dayLabel(day, index)}</h3>
          {items.length === 0 ? <p>Không có ca.</p> : <ul>
            {items.map(shift => <li key={shift.id}>
              <span>{vietnamTime(shift.startAt)}–{vietnamTime(shift.endAt)}</span> · <span>{shift.location}</span> · <strong>{STATUS_LABELS[shift.status]}</strong>
              {canEdit(shift) && <button type="button" className="secondary" onClick={() => openEdit(shift)} disabled={Boolean(form)}>Sửa</button>}
            </li>)}
          </ul>}
        </section>;
      })}
    </>}
  </section>;
}
