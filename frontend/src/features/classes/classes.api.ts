// Tầng giao diện – gọi API (US-26 bước 3): lịch lớp miễn phí công khai, chỉ có lệnh GET.
// Dùng apiGet (không gắn access token) vì route public; Guest và Member nhận cùng dữ liệu (US-26-TC03, TC10).
import { apiGet } from '../../api/client';

export interface Subject {
  code: string;
  label: string;
}

// Đúng 11 field công khai backend trả (US-26-F03).
export interface PublicSession {
  id: string;
  title: string;
  subjectCode: string;
  subjectLabel: string;
  trainerId: string;
  trainerName: string | null;
  startAt: string;
  endAt: string;
  location: string;
  status: 'PUBLISHED';
  ended: boolean;
}

export interface PublicSessionPage {
  items: PublicSession[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// fromDate/toDate là ngày Việt Nam YYYY-MM-DD; không có tham số status (US-26-TC01).
export interface PublicSessionQuery {
  fromDate: string;
  toDate: string;
  subjectCode?: string;
  page?: number;
}

export const classesApi = {
  subjects() {
    return apiGet<Subject[]>('/public-session-subjects');
  },
  list(query: PublicSessionQuery) {
    const params = new URLSearchParams({ fromDate: query.fromDate, toDate: query.toDate });
    if (query.subjectCode) params.set('subjectCode', query.subjectCode);
    if (query.page && query.page > 1) params.set('page', String(query.page));
    return apiGet<PublicSessionPage>(`/public-sessions?${params.toString()}`);
  },
  detail(id: string) {
    return apiGet<PublicSession>(`/public-sessions/${encodeURIComponent(id)}`);
  },
};
