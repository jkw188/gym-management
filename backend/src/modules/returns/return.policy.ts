import { ApplicationError } from '../../common/errors/application-error';
import { addCalendarDays } from '../../common/utils/business-date';

export function returnDeadline(fulfilledAt: Date): Date {
  if (!(fulfilledAt instanceof Date) || !Number.isFinite(fulfilledAt.getTime())) throw new ApplicationError(409, 'ORDER_INTEGRITY_ERROR', 'Thiếu thời điểm bàn giao hợp lệ');
  const day = new Date(fulfilledAt.getTime() + 7 * 3600000).toISOString().slice(0, 10);
  return new Date(`${addCalendarDays(day, 7)}T00:00:00+07:00`);
}
export function assertReturnWindow(fulfilledAt: Date, now: Date) {
  if (now < fulfilledAt || now >= returnDeadline(fulfilledAt)) throw new ApplicationError(409, 'RETURN_WINDOW_EXPIRED', 'Đã ngoài thời hạn 7 ngày lịch nhận trả');
}
