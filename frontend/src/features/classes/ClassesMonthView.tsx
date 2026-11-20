// Tầng giao diện – thành phần của trang /classes: chế độ xem "Tháng" dạng cuốn lịch 7 cột (Thứ Hai → Chủ nhật).
// Ngày có lớp ghi tên lớp và giờ; bấm vào lớp thì trang cha mở chi tiết (vẫn hỏi lại server). Chỉ đọc, không gửi request ghi.
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { addDays, vietnamDate, vietnamTime } from '../shifts/shift-time';
import { classesApi, type PublicSessionPage } from './classes.api';
import { Icon } from '../../components/Icon';

// Mỗi ô ngày hiện tối đa 3 lớp, còn lại ghi "+N lớp khác" để ô không quá cao.
const MAX_PER_DAY = 3;
const WEEKDAYS = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'CN'];

// "2026-11" → ngày cuối tháng, ví dụ "2026-11-30". Date.UTC(năm, tháng, 0) là ngày cuối của tháng trước tháng đó.
function lastDayOf(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(days).padStart(2, '0')}`;
}

// Cộng/trừ số tháng: "2026-11" + 1 → "2026-12".
function addMonths(month: string, n: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + n, 1));
  return date.toISOString().slice(0, 7);
}

export function ClassesMonthView({ subjectCode, reloadCount, onOpen }: {
  subjectCode: string;
  reloadCount: number;
  onOpen: (id: string) => void;
}) {
  const today = vietnamDate(new Date());
  // Tháng đang xem dạng "YYYY-MM", mặc định tháng hiện tại theo giờ Việt Nam.
  const [month, setMonth] = useState(today.slice(0, 7));
  const [data, setData] = useState<PublicSessionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  // Ngày đang mở rộng để xem hết lớp (khi có hơn 3 lớp).
  const [expandedDay, setExpandedDay] = useState('');

  const firstDay = `${month}-01`;
  const lastDay = lastDayOf(month);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError('');
    setData(null);
    // Một tháng tối đa 31 ngày, đúng giới hạn khoảng ngày của API (US-26).
    classesApi.list({ fromDate: firstDay, toDate: lastDay, subjectCode, limit: 100 })
      .then(result => { if (!ignore) setData(result); })
      .catch(failure => { if (!ignore) setError(failure instanceof ApiError ? failure.message : 'Không tải được lịch lớp.'); })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [firstDay, lastDay, subjectCode, reloadCount, retry]);

  // Ô đầu tiên của lưới là Thứ Hai của tuần chứa ngày 1; getUTCDay: 0 = Chủ nhật, 1 = Thứ Hai…
  const weekdayOfFirst = new Date(`${firstDay}T00:00:00Z`).getUTCDay();
  const gridStart = addDays(firstDay, -((weekdayOfFirst + 6) % 7));
  // Đủ số tuần để phủ hết tháng (4–6 hàng).
  const cellCount = Math.ceil(((weekdayOfFirst + 6) % 7 + Number(lastDay.slice(8))) / 7) * 7;
  const cells = Array.from({ length: cellCount }, (_, index) => addDays(gridStart, index));

  return <div className="month-view">
    <div className="month-head" role="group" aria-label="Chọn tháng">
      <button type="button" className="secondary" onClick={() => setMonth(addMonths(month, -1))}><Icon name="prev" label="Tháng trước" /></button>
      <span>Tháng {month.slice(5, 7)}/{month.slice(0, 4)}</span>
      <button type="button" className="secondary" onClick={() => setMonth(addMonths(month, 1))}><Icon name="next" label="Tháng sau" /></button>
    </div>

    {loading && <p>Đang tải lịch tháng...</p>}
    {error && <div className="form-error" role="alert"><p>{error}</p>
      <button type="button" onClick={() => setRetry(count => count + 1)}><Icon name="retry" label="Thử lại" /></button></div>}
    {data && data.total > data.items.length && <p className="hint">Tháng này có {data.total} lớp, lịch chỉ hiện {data.items.length} lớp đầu tiên.</p>}

    {data && <div className="month-grid" role="grid" aria-label={`Lịch lớp tháng ${month.slice(5, 7)}/${month.slice(0, 4)}`}>
      {WEEKDAYS.map(name => <div key={name} className="month-weekday" role="columnheader">{name}</div>)}
      {cells.map(day => {
        const inMonth = day.slice(0, 7) === month;
        // Lớp của ngày này (theo ngày Việt Nam), giữ thứ tự server trả.
        const sessions = inMonth ? data.items.filter(session => vietnamDate(new Date(session.startAt)) === day) : [];
        const classNames = ['month-cell', inMonth ? '' : 'month-cell-outside', day === today ? 'month-cell-today' : ''].join(' ').trim();
        return <div key={day} className={classNames} role="gridcell" aria-label={`Ngày ${day.slice(8, 10)}/${day.slice(5, 7)}`}>
          <span className="month-day-number">{Number(day.slice(8, 10))}</span>
          {(day === expandedDay ? sessions : sessions.slice(0, MAX_PER_DAY)).map(session => <button key={session.id} type="button"
            className={session.ended ? 'month-event month-event-ended' : 'month-event'} onClick={() => onOpen(session.id)}
            title={`${session.title} – ${session.location}`}>
            <span className="month-event-time">{vietnamTime(session.startAt)}</span> {session.title}
          </button>)}
          {sessions.length > MAX_PER_DAY && day !== expandedDay && <button type="button" className="month-more"
            onClick={() => setExpandedDay(day)}>+{sessions.length - MAX_PER_DAY} lớp khác</button>}
        </div>;
      })}
    </div>}
    {data && data.items.length === 0 && <p>Tháng này chưa có lớp nào.</p>}
  </div>;
}
