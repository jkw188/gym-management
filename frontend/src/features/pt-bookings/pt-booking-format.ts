// Tầng giao diện – dùng chung (US-27, US-29): định dạng giờ Việt Nam và nhãn trạng thái buổi PT,
// dùng cho trang Member /member/pt-bookings và trang hỗ trợ /staff/pt-bookings. Chỉ hiển thị, không có luật nghiệp vụ.
import type { PtBookingStatus } from './pt-bookings.api';

export const STATUS_LABELS: Record<PtBookingStatus, string> = { BOOKED: 'Đã đặt', COMPLETED: 'Đã hoàn thành', CANCELLED: 'Đã hủy' };

// US-27-TC11: mọi thời điểm hiển thị theo giờ Việt Nam, kể cả khi máy người dùng ở múi giờ khác.
const vnDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' });
const vnTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export const formatDate = (iso: string) => vnDate.format(new Date(iso));                     // "25/11/2026"
export const formatTime = (iso: string) => vnTime.format(new Date(iso));                     // "08:00"
export const formatRange = (startAt: string, endAt: string) => `${formatTime(startAt)}–${formatTime(endAt)}`;  // "09:00–10:00"
export const formatAsOf = (iso: string) => `${formatTime(iso)} ${formatDate(iso)}`;          // "10:05 20/11/2026"
