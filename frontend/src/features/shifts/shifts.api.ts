// Tầng giao diện – gọi API (US-24 bước 3): ca nháp của chính PT qua ApiClient (tự gắn Bearer token).
// Không gửi trainerId vì server lấy PT từ phiên đăng nhập; lệnh ghi gửi header Idempotency-Key (EN-02).
import { apiClient } from '../../api/client';

export type ShiftStatus = 'SCHEDULED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';

export interface Shift {
  id: string;
  startAt: string;
  endAt: string;
  location: string;
  status: ShiftStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShiftPage {
  profileLinked: boolean;
  items: Shift[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ShiftListQuery { fromDate: string; toDate: string; status?: ShiftStatus; page?: number; limit?: number }

// startAt/endAt là chuỗi ISO 8601 có offset, ví dụ 2026-11-05T08:10:00+07:00.
export interface ShiftInput { startAt: string; endAt: string; location: string }

export const shiftsApi = {
  list(query: ShiftListQuery) {
    const params = new URLSearchParams({ fromDate: query.fromDate, toDate: query.toDate });
    if (query.status) params.set('status', query.status);
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));
    return apiClient.request<ShiftPage>(`/me/work-shifts?${params.toString()}`);
  },
  create(input: ShiftInput, idempotencyKey: string) {
    return apiClient.request<Shift>('/me/work-shifts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
  },
  // PATCH gửi đủ dữ liệu ca kèm version đang xem; server từ chối 409 VERSION_CONFLICT nếu ca đã đổi.
  update(id: string, input: ShiftInput & { version: number }, idempotencyKey: string) {
    return apiClient.request<Shift>(`/me/work-shifts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
  },
};
