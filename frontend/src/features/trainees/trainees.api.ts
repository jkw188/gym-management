// Tầng giao diện – gọi API (US-30 bước 3): PT tra cứu học viên của mình qua /api/me/trainees (chỉ GET).
// Không gửi trainerId/accountId: server lấy PT từ phiên đăng nhập. Gọi backend qua apiClient (api/client.ts).
import { apiClient } from '../../api/client';
import type { PtBookingStatus } from '../pt-bookings/pt-bookings.api';

// GET /api/me/trainees: một dòng học viên (US-30-F02).
export interface TraineeListItem {
  memberId: string;
  memberCode: string;
  fullName: string;
  nextBookingAt?: string;
  lastCompletedAt?: string;
  relatedBookingCount: number;
  hasUpcoming: boolean;
}

// Khuôn trang chung của spec mục 2.
export interface TraineePage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// profileLinked=false: account PT chưa có hồ sơ PT (US-30-TC04), không phải lỗi.
export interface TraineeListPage extends TraineePage<TraineeListItem> {
  profileLinked: boolean;
}

// GET /api/me/trainees/:memberId: hồ sơ tối thiểu, không có thông tin liên hệ.
export interface TraineeDetail {
  memberId: string;
  memberCode: string;
  fullName: string;
  hasUpcoming: boolean;
}

// GET /api/me/trainees/:memberId/bookings: một buổi do chính PT dạy.
export interface TraineeBooking {
  id: string;
  membershipId: string;
  startAt: string;
  endAt: string;
  status: PtBookingStatus;
  location: string;
  completedAt?: string;
}

export type MembershipStoredStatus = 'ACTIVE' | 'SUPERSEDED' | 'CANCELLED';

// GET /api/me/trainees/:memberId/memberships: một gói liên quan, số liệu quota do server tính (US-30-F03).
export interface TraineeMembership {
  id: string;
  kind?: 'GYM' | 'PT';
  storedStatus: MembershipStoredStatus;
  startDate: string;
  endDate: string;
  quota: number;
  sessionsUsed: number;
  reserved: number;
  available: number;
  // true khi quota − đã dùng − giữ chỗ < 0: dữ liệu bất thường.
  quotaInvalid: boolean;
}

export interface TraineeMembershipPage extends TraineePage<TraineeMembership> {
  // Thời điểm server tính quota.
  asOf: string;
}

const memberPath = (memberId: string) => `/me/trainees/${encodeURIComponent(memberId)}`;

export const traineesApi = {
  // US-30-TC12: danh sách học viên; q gửi nguyên văn (server tìm literal), page bắt đầu từ 1.
  list(q: string, page: number) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    params.set('page', String(page));
    return apiClient.request<TraineeListPage>(`/me/trainees?${params.toString()}`);
  },

  detail(memberId: string) {
    return apiClient.request<TraineeDetail>(memberPath(memberId));
  },

  // Không gửi ngày → server mặc định tuần hiện tại từ thứ Hai (spec mục 2).
  bookings(memberId: string) {
    return apiClient.request<TraineePage<TraineeBooking>>(`${memberPath(memberId)}/bookings`);
  },

  memberships(memberId: string) {
    return apiClient.request<TraineeMembershipPage>(`${memberPath(memberId)}/memberships`);
  },
};
