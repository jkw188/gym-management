import { invalidField } from '../../common/errors/application-error';
import { addCalendarDays, assertBusinessDate } from '../../common/utils/business-date';

// US-31/33: cùng kỳ gửi theo ngày Việt Nam, tính cả hai đầu.
export function reviewPeriod(today: string, fromDate?: string, toDate?: string) {
  const realDate = (value: string, field: string) => {
    try { return assertBusinessDate(value); }
    catch { return invalidField(field, 'Ngày không có thật'); }
  };
  const toDay = toDate === undefined ? today : realDate(toDate, 'toDate');
  const fromDay = fromDate === undefined ? addCalendarDays(toDay, -29) : realDate(fromDate, 'fromDate');
  const days = (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86400000 + 1;
  const field = toDate === undefined ? 'fromDate' : 'toDate';
  if (days < 1) invalidField(field, toDate === undefined ? 'fromDate không được sau hôm nay' : 'toDate không được trước fromDate');
  if (days > 366) invalidField(field, 'Chỉ xem tối đa 366 ngày mỗi lần');
  return { fromDate: fromDay, toDate: toDay,
    from: new Date(`${fromDay}T00:00:00+07:00`), to: new Date(`${addCalendarDays(toDay, 1)}T00:00:00+07:00`) };
}
