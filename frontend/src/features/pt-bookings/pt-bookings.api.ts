// Tầng giao diện – gọi API (US-27 bước 3, US-28 bước 4): Member đọc lịch PT riêng, danh mục PT, slot trống, gói PT và đặt slot PT qua ApiClient.
// Không gửi memberId/accountId vì server lấy chủ thể từ phiên đăng nhập; lệnh đặt gửi header Idempotency-Key (EN-02).
import { apiClient } from '../../api/client';
import type { MyListPage, MyMembership } from '../memberships/memberships.api';

export type PtBookingStatus = 'BOOKED' | 'COMPLETED' | 'CANCELLED';
export type SlotReason = 'MEMBERSHIP_REQUIRED' | 'MEMBERSHIP_NOT_ELIGIBLE' | 'QUOTA_EXHAUSTED';

// Một buổi trong lịch riêng; tên PT và địa điểm là snapshot lúc đặt (US-27-F05).
export interface MyPtBooking {
  id: string;
  membershipId: string;
  trainerId: string;
  trainerName: string;
  shiftId: string;
  startAt: string;   // ISO UTC
  endAt: string;
  location: string;
  status: PtBookingStatus;
  version: number;
  cancelAllowed: boolean;
}

export interface PtTrainer {
  id: string;
  displayName: string;
  specialty: string;
}

export interface PtSlot {
  shiftId: string;
  startAt: string;
  endAt: string;
  location: string;
  bookable: boolean;
  reason?: SlotReason;
}

export interface PtAvailability {
  trainerId: string;
  memberLinked: boolean;
  asOf: string;
  slots: PtSlot[];
}

export interface PtTrainerPage {
  items: PtTrainer[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Bộ lọc lịch riêng; ngày để trống thì server mặc định tuần hiện tại.
export interface BookingFilter {
  fromDate: string;
  toDate: string;
  status: PtBookingStatus | '';
  page: number;
}

// US-28: dữ liệu Member gửi khi đặt một slot (startAt lấy nguyên từ slot server trả).
export interface CreateBookingInput {
  membershipId: string;
  trainerId: string;
  shiftId: string;
  startAt: string;
}

// 201 của POST /api/me/pt-bookings (US-28 spec mục 3).
export interface CreatedBooking {
  id: string;
  memberId: string;
  membershipId: string;
  trainerId: string;
  shiftId: string;
  startAt: string;
  endAt: string;
  location: string;
  status: 'BOOKED';
  version: number;
  notificationState: 'STORED' | 'NO_LINKED_ACCOUNT';
}

export const BOOKINGS_PAGE_SIZE = 20;

export const ptBookingsApi = {
  // GET /api/me/pt-bookings: chỉ gửi những bộ lọc người dùng đã chọn.
  listBookings(filter: BookingFilter) {
    const params = new URLSearchParams({ page: String(filter.page), limit: String(BOOKINGS_PAGE_SIZE) });
    if (filter.fromDate) params.set('fromDate', filter.fromDate);
    if (filter.toDate) params.set('toDate', filter.toDate);
    if (filter.status) params.set('status', filter.status);
    return apiClient.request<MyListPage<MyPtBooking>>(`/me/pt-bookings?${params.toString()}`);
  },

  // GET /api/me/pt-trainers: tải tối đa 100 PT (limit lớn nhất server cho phép).
  listTrainers() {
    return apiClient.request<PtTrainerPage>('/me/pt-trainers?page=1&limit=100');
  },

  // GET /api/me/pt-trainers/:id/availability cho đúng một ngày; membershipId chỉ gửi khi Member đã chọn gói.
  availability(trainerId: string, day: string, membershipId: string) {
    const params = new URLSearchParams({ fromDate: day, toDate: day });
    if (membershipId) params.set('membershipId', membershipId);
    return apiClient.request<PtAvailability>(`/me/pt-trainers/${encodeURIComponent(trainerId)}/availability?${params.toString()}`);
  },

  // US-27-TC08: gói PT ACTIVE đang hiệu lực hoặc chờ hiệu lực, server lọc và tính sẵn số buổi.
  // Server chỉ nhận một timeState mỗi lần nên gọi hai lần (CURRENT, SCHEDULED) rồi ghép lại.
  async listUsablePtMemberships() {
    const query = (timeState: string) => `/me/memberships?page=1&limit=100&kind=PT&storedStatus=ACTIVE&timeState=${timeState}`;
    const current = await apiClient.request<MyListPage<MyMembership>>(query('CURRENT'));
    const scheduled = await apiClient.request<MyListPage<MyMembership>>(query('SCHEDULED'));
    return { memberLinked: current.memberLinked, asOf: current.asOf, items: [...current.items, ...scheduled.items] };
  },

  // POST /api/me/pt-bookings (US-28): body CHỈ 4 field; không gửi endAt/memberId/location vì server tự tính và lấy từ ca.
  // idempotencyKey do trang giữ: gửi lại đúng key khi mất phản hồi để server trả kết quả gốc, không đặt hai lần (US-28-TC10).
  createBooking(input: CreateBookingInput, idempotencyKey: string) {
    return apiClient.request<CreatedBooking>('/me/pt-bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
  },
};
