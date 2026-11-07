// Tầng giao diện – trang (US-26 bước 3): /classes – Guest/Member xem lịch lớp miễn phí đã công bố theo tuần, lọc bộ môn.
// Chỉ xem: không có nút đăng ký/đặt chỗ, không gửi request ghi nào (US-26-F04, TC10).
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { addDays, mondayOf, vietnamDate, vietnamTime } from '../shifts/shift-time';
import { classesApi, type PublicSession, type PublicSessionPage, type Subject } from './classes.api';

// "2026-11-05" → "05/11".
const shortDate = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

// US-26-TC06: ngày và giờ hiển thị theo giờ Việt Nam, không theo UTC.
const sessionTime = (session: PublicSession) =>
  `${shortDate(vietnamDate(new Date(session.startAt)))} ${vietnamTime(session.startAt)}–${vietnamTime(session.endAt)}`;

const errorText = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

// US-26-TC08: mọi dữ liệu Admin nhập (title, location...) hiển thị bằng {} của React → luôn là chữ, không thành thẻ HTML.
function SessionInfo({ session }: { session: PublicSession }) {
  return <>
    <span className="shift-time">{sessionTime(session)}</span>
    <strong>{session.title}</strong>
    <span>Bộ môn: {session.subjectLabel}</span>
    <span>PT: {session.trainerName ?? 'Chưa có tên'}</span>
    <span>Địa điểm: {session.location}</span>
    {/* US-26-TC04: lớp đã qua vẫn hiện, kèm nhãn. */}
    {session.ended && <span className="session-ended">Đã kết thúc</span>}
  </>;
}

export function ClassesPage() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  // Bộ lọc: thứ Hai của tuần đang xem, bộ môn (rỗng = tất cả) và trang.
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [subjectCode, setSubjectCode] = useState('');
  const [page, setPage] = useState(1);
  // Tăng số này để tải lại danh sách với đúng bộ lọc hiện tại (nút "Thử lại", detail 404).
  const [reloadCount, setReloadCount] = useState(0);

  const [data, setData] = useState<PublicSessionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<PublicSession | null>(null);

  // Taxonomy bộ môn do backend sở hữu (US-66), tải một lần.
  useEffect(() => {
    classesApi.subjects().then(setSubjects).catch(() => setSubjects([]));
  }, []);

  // Tải danh sách mỗi khi bộ lọc đổi hoặc bấm tải lại.
  useEffect(() => {
    // ignore = true khi bộ lọc đã đổi tiếp: bỏ kết quả cũ về muộn.
    let ignore = false;
    setLoading(true);
    setListError('');
    // US-26-TC12: đang tải hoặc lỗi thì không hiện lớp cũ như thể còn lịch.
    setData(null);
    // US-26-TC01, TC05: tuần thứ Hai → Chủ nhật, kèm bộ môn và trang; không gửi status.
    classesApi.list({ fromDate: weekStart, toDate: addDays(weekStart, 6), subjectCode, page })
      .then(result => { if (!ignore) setData(result); })
      .catch(error => { if (!ignore) setListError(errorText(error, 'Không tải được lịch lớp.')); })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [weekStart, subjectCode, page, reloadCount]);

  // Đổi tuần hoặc bộ môn thì về trang 1 và xóa thông báo cũ (US-26-TC05).
  function changeWeek(days: number) {
    setNotice('');
    setPage(1);
    setWeekStart(addDays(weekStart, days));
  }

  function changeSubject(code: string) {
    setNotice('');
    setPage(1);
    setSubjectCode(code);
  }

  // US-26-TC01: "Xem chi tiết" luôn hỏi lại server, không tin bản trong danh sách.
  async function openDetail(id: string) {
    setNotice('');
    try {
      setSelected(await classesApi.detail(id));
    } catch (error) {
      // US-26-TC09: lớp vừa bị hủy/không còn công bố → báo và tải lại danh sách.
      if (error instanceof ApiError && error.code === 'SESSION_NOT_FOUND') {
        setNotice('Lớp này không còn được công bố. Lịch đã được tải lại.');
        setReloadCount(count => count + 1);
      } else {
        setNotice(errorText(error, 'Không tải được chi tiết lớp.'));
      }
    }
  }

  return <section className="auth-card classes-page">
    <h2>Lịch lớp miễn phí</h2>
    <p>Lịch tham khảo công khai, không cần đăng ký chỗ.</p>

    <div className="user-actions" role="group" aria-label="Chọn tuần">
      <button type="button" className="secondary" onClick={() => changeWeek(-7)}>Tuần trước</button>
      <span>{shortDate(weekStart)} – {shortDate(addDays(weekStart, 6))}</span>
      <button type="button" className="secondary" onClick={() => changeWeek(7)}>Tuần sau</button>
    </div>

    <label htmlFor="class-subject">Bộ môn</label>
    <select id="class-subject" value={subjectCode} onChange={event => changeSubject(event.target.value)}>
      <option value="">Tất cả bộ môn</option>
      {subjects.map(subject => <option key={subject.code} value={subject.code}>{subject.label}</option>)}
    </select>

    {notice && <p className="form-error" role="alert">{notice}</p>}

    {loading && <p>Đang tải lịch lớp...</p>}

    {/* US-26-TC12: lỗi DB/mạng có nút thử lại, giữ nguyên bộ lọc. */}
    {listError && <div className="form-error" role="alert"><p>{listError}</p>
      <button type="button" onClick={() => setReloadCount(count => count + 1)}>Thử lại</button></div>}

    {/* US-26-TC04: tuần không có lớp. */}
    {data && data.items.length === 0 && <p>Không có lớp nào trong khoảng này.</p>}

    {/* US-26-TC05: giữ đúng thứ tự server trả (startAt rồi id). */}
    {data && data.items.length > 0 && <ul aria-label="Danh sách lớp" className="class-list">
      {data.items.map(session => <li key={session.id} className="shift-item">
        <SessionInfo session={session} />
        <div className="shift-item-actions">
          <button type="button" className="secondary" onClick={() => openDetail(session.id)}>Xem chi tiết</button>
        </div>
      </li>)}
    </ul>}

    {data && data.totalPages > 1 && <div className="user-actions">
      {data.page > 1 && <button type="button" className="secondary" onClick={() => setPage(page - 1)}>Trang trước</button>}
      <span>Trang {data.page}/{data.totalPages}</span>
      {data.page < data.totalPages && <button type="button" className="secondary" onClick={() => setPage(page + 1)}>Trang sau</button>}
    </div>}

    {selected && <div role="dialog" aria-modal="true" aria-labelledby="class-detail-title" className="auth-card">
      <h3 id="class-detail-title">Chi tiết lớp</h3>
      <div className="class-detail"><SessionInfo session={selected} /></div>
      <div className="user-actions">
        <button type="button" className="secondary" onClick={() => setSelected(null)}>Đóng</button>
      </div>
    </div>}
  </section>;
}
