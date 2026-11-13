// Tầng giao diện – trang (US-29 bước 3): trang /staff/pt-bookings – Staff/Admin tra cứu lịch PT theo ngày/trạng thái, xem chi tiết
// và hủy hỗ trợ có lý do (kể cả sát giờ hoặc đã qua giờ). Không có nút hoàn tất buổi trong S04. Luật hủy do server kiểm.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { formatDate, formatRange, STATUS_LABELS } from './pt-booking-format';
import {
  isValidCancelReason, ptBookingsApi, type CancelBookingInput, type PtBookingStatus, type SupportFilter, type SupportPtBooking,
  type SupportPtBookingPage,
} from './pt-bookings.api';
import { Icon } from '../../components/Icon';

const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);

export function SupportPtBookingsPage() {
  // Bộ lọc đang gõ trên form và bộ lọc đã bấm "Tìm" (dùng để tải lại sau khi hủy).
  const [form, setForm] = useState<SupportFilter>({ fromDate: '', toDate: '', status: '', page: 1 });
  const [applied, setApplied] = useState<SupportFilter>({ fromDate: '', toDate: '', status: '', page: 1 });
  const [results, setResults] = useState<SupportPtBookingPage | null>(null);
  const [resultsError, setResultsError] = useState('');

  // Chi tiết buổi đang xem.
  const [detailId, setDetailId] = useState('');
  const [detail, setDetail] = useState<SupportPtBooking | null>(null);
  const [detailError, setDetailError] = useState('');

  // US-29: form hủy hỗ trợ, trạng thái gửi và kết quả.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [cancelSuccess, setCancelSuccess] = useState('');
  const [cancelError, setCancelError] = useState('');
  const cancellingNow = useRef(false);
  // US-29-TC12: mất phản hồi/503 rồi bấm lại cùng dữ liệu → dùng LẠI key cũ; xong hoặc bị 409 → bỏ key.
  const pendingKey = useRef<{ payload: string; key: string } | null>(null);

  // Kết quả cũ về muộn (đã bấm tìm lần khác) thì bỏ qua.
  const latestResults = useRef(0);
  const latestDetail = useRef(0);

  // US-29-TC05: GET /pt-bookings theo bộ lọc đã áp dụng; để trống ngày thì server lấy tuần hiện tại.
  const loadResults = useCallback(async () => {
    const loadNumber = ++latestResults.current;
    setResultsError('');
    try {
      const page = await ptBookingsApi.listSupportBookings(applied);
      if (loadNumber === latestResults.current) setResults(page);
    } catch (error) {
      if (loadNumber === latestResults.current) setResultsError(errorMessage(error, 'Không tải được danh sách lịch PT.'));
    }
  }, [applied]);

  // US-29-TC05: GET /pt-bookings/:id – lấy version hiện tại để hủy.
  const loadDetail = useCallback(async () => {
    const loadNumber = ++latestDetail.current;
    setDetailError('');
    if (!detailId) { setDetail(null); return; }
    try {
      const booking = await ptBookingsApi.supportBooking(detailId);
      if (loadNumber === latestDetail.current) setDetail(booking);
    } catch (error) {
      if (loadNumber === latestDetail.current) setDetailError(errorMessage(error, 'Không tải được chi tiết lịch PT.'));
    }
  }, [detailId]);

  useEffect(() => { void loadResults(); }, [loadResults]);
  useEffect(() => { void loadDetail(); }, [loadDetail]);

  // Bấm "Tìm": áp dụng bộ lọc trên form, về trang 1.
  function search() {
    setApplied({ ...form, page: 1 });
  }

  function openDetail(id: string) {
    setCancelOpen(false);
    setCancelSuccess('');
    setCancelError('');
    setDetail(null);
    setDetailId(id);
  }

  function openCancel() {
    setReason('');
    setCancelSuccess('');
    setCancelError('');
    setCancelOpen(true);
  }

  // US-29-TC05, TC06, TC09, TC12: gửi hủy hỗ trợ cho buổi đang xem chi tiết.
  async function submitCancel() {
    if (!detail || cancellingNow.current || !isValidCancelReason(reason)) return;
    cancellingNow.current = true;
    setCancelling(true);
    setCancelSuccess('');
    setCancelError('');

    // Body CHỈ {version, reason}: version của chi tiết đang xem, lý do đã bỏ khoảng trắng hai đầu.
    const input: CancelBookingInput = { version: detail.version, reason: reason.trim() };
    const payload = JSON.stringify({ id: detail.id, ...input });
    if (pendingKey.current?.payload !== payload) pendingKey.current = { payload, key: crypto.randomUUID() };

    try {
      await ptBookingsApi.cancelSupportBooking(detail.id, input, pendingKey.current.key);
      pendingKey.current = null;
      setCancelOpen(false);
      setCancelSuccess(`Đã hủy lịch của ${detail.memberCode} – ${detail.memberName}.`);
      await loadResults();
      await loadDetail();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // US-29-TC12: buổi vừa đổi (version) hoặc không còn BOOKED → tải lại chi tiết để thấy dữ liệu mới, lần sau là ý định mới.
        pendingKey.current = null;
        setCancelOpen(false);
        setCancelError(`${errorMessage(error, 'Không hủy được buổi này.')} Chi tiết đã được tải lại, vui lòng kiểm tra rồi hủy lại nếu cần.`);
        await loadDetail();
        await loadResults();
      } else {
        // US-29-TC06 (403), TC12 (mất phản hồi/503): báo lỗi, giữ ô lý do và key, KHÔNG tự gửi lại.
        setCancelError(`${errorMessage(error, 'Không gửi được yêu cầu hủy.')} Bấm "Xác nhận hủy" để thử lại.`);
      }
    } finally {
      cancellingNow.current = false;
      setCancelling(false);
    }
  }

  return <section className="auth-card pt-bookings">
    <h2>Tra cứu lịch PT</h2>

    {/* Thanh tra cứu một hàng: từ ngày, đến ngày, trạng thái, nút tìm; dòng gợi ý nằm dưới. */}
    <form className="toolbar" onSubmit={event => { event.preventDefault(); search(); }}>
      <label>Từ ngày <input type="date" value={form.fromDate} onChange={event => setForm({ ...form, fromDate: event.target.value })} /></label>
      <label>Đến ngày <input type="date" value={form.toDate} onChange={event => setForm({ ...form, toDate: event.target.value })} /></label>
      <label>Trạng thái <select value={form.status} onChange={event => setForm({ ...form, status: event.target.value as PtBookingStatus | '' })}>
        <option value="">Tất cả</option>
        <option value="BOOKED">Đã đặt</option>
        <option value="COMPLETED">Đã hoàn thành</option>
        <option value="CANCELLED">Đã hủy</option>
      </select></label>
      <button type="submit"><Icon name="search" label="Tìm" /></button>
      <p className="hint">Để trống ngày thì xem tuần hiện tại (từ thứ Hai). Tối đa 31 ngày mỗi lần.</p>
    </form>

    <section aria-labelledby="support-results">
      <h3 id="support-results">Kết quả</h3>
      {resultsError
        ? <div role="alert"><p>{resultsError}</p><button type="button" onClick={() => void loadResults()}><Icon name="retry" label="Thử lại" /></button></div>
        : !results ? <p>Đang tải…</p>
          : results.items.length === 0 ? <p>Không có buổi PT nào trong khoảng này.</p>
            : <>
              {results.items.map(item => <article key={item.id}>
                <p><strong>{item.memberCode}</strong> – {item.memberName}</p>
                <p>PT: {item.trainerName}</p>
                <p>{formatDate(item.startAt)} · {formatRange(item.startAt, item.endAt)}</p>
                <p><span>{STATUS_LABELS[item.status]}</span></p>
                <button type="button" onClick={() => openDetail(item.id)}>Chi tiết</button>
              </article>)}
              {results.totalPages > 1 && <p>
                <button type="button" disabled={applied.page <= 1}
                  onClick={() => setApplied(current => ({ ...current, page: current.page - 1 }))}><Icon name="prev" label="Trang trước" /></button>
                {' '}Trang {applied.page}/{results.totalPages} ({results.total} buổi){' '}
                <button type="button" disabled={applied.page >= results.totalPages}
                  onClick={() => setApplied(current => ({ ...current, page: current.page + 1 }))}><Icon name="next" label="Trang sau" /></button>
              </p>}
            </>}
    </section>

    {detailId && <section aria-labelledby="support-detail">
      <h3 id="support-detail">Chi tiết lịch PT</h3>
      {detailError
        ? <div role="alert"><p>{detailError}</p><button type="button" onClick={() => void loadDetail()}><Icon name="retry" label="Thử lại" /></button></div>
        : !detail ? <p>Đang tải chi tiết…</p>
          : <>
            <ul>
              <li>Hội viên: {detail.memberCode} – {detail.memberName}</li>
              <li>PT: {detail.trainerName}</li>
              <li>Thời gian: {formatDate(detail.startAt)} · {formatRange(detail.startAt, detail.endAt)}</li>
              <li>Địa điểm: {detail.location}</li>
              <li>Trạng thái: <span>{STATUS_LABELS[detail.status]}</span></li>
            </ul>
            {/* US-29-F02, TC05: buổi BOOKED được hủy hỗ trợ kể cả sát giờ hoặc đã qua giờ; S04 không có nút hoàn tất buổi. */}
            {detail.status === 'BOOKED' && !cancelOpen && <button type="button" onClick={openCancel}>Hủy hỗ trợ</button>}
            {detail.status === 'BOOKED' && cancelOpen && <div>
              <label>Lý do hủy <textarea value={reason} disabled={cancelling} onChange={event => setReason(event.target.value)} /></label>
              <p className="hint">Lý do dài từ 10 đến 500 ký tự, được lưu vào lịch sử thao tác.</p>
              {/* US-29-TC06, TC09: lý do không hợp lệ hoặc đang gửi thì khóa nút. */}
              <button type="button" disabled={cancelling || !isValidCancelReason(reason)} onClick={() => void submitCancel()}>Xác nhận hủy</button>
              {' '}<button type="button" disabled={cancelling} onClick={() => setCancelOpen(false)}><Icon name="close" label="Đóng" /></button>
            </div>}
          </>}
    </section>}

    {cancelSuccess && <p role="status">{cancelSuccess}</p>}
    {cancelError && <p role="alert">{cancelError}</p>}
  </section>;
}
