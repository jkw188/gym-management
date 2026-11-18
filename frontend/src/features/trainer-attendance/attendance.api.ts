import { apiClient } from '../../api/client';
import type { ActivityShift, AttendanceSource } from '../trainer-activity/trainer-activity.api';

export type AttendanceCommand = 'ATTENDANCE_CHECK_IN' | 'ATTENDANCE_CHECK_OUT' | 'ATTENDANCE_CORRECT';
export interface AttendanceFilter { fromDate: string; toDate: string; trainerId: string; page: number }
export interface AttendancePage {
  items: ActivityShift[]; trainers: { id: string; displayName: string | null }[];
  total: number; totalPages: number; page: number; limit: number; asOf: string;
}
export type AttendanceDetail = Omit<AttendanceSource, 'events'> & { events?: AttendanceSource['events']; note?: string | null };
export interface PendingAttendance {
  operation: AttendanceCommand; shiftId: string; key: string;
  body: { version?: number; note?: string; checkInAt?: string; checkOutAt?: string; reason?: string };
}
const paths: Record<AttendanceCommand, string> = {
  ATTENDANCE_CHECK_IN: 'check-in', ATTENDANCE_CHECK_OUT: 'check-out', ATTENDANCE_CORRECT: 'corrections',
};
export const attendanceApi = {
  list(filter: AttendanceFilter, signal?: AbortSignal) {
    const params = new URLSearchParams({ page: String(filter.page) });
    for (const key of ['fromDate', 'toDate', 'trainerId'] as const) if (filter[key]) params.set(key, filter[key]);
    return apiClient.request<AttendancePage>(`/work-shifts?${params}`, { signal });
  },
  detail(id: string, signal?: AbortSignal) { return apiClient.request<AttendanceDetail>(`/work-shifts/${encodeURIComponent(id)}/attendance`, { signal }); },
  send(command: PendingAttendance) {
    return apiClient.request(`/work-shifts/${encodeURIComponent(command.shiftId)}/attendance/${paths[command.operation]}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': command.key }, body: JSON.stringify(command.body),
    });
  },
  lookup(command: PendingAttendance) {
    return apiClient.request<{ status: 'COMMITTED'; responseStatus: number; responseBody: unknown }>(`/operations/${command.operation}/${command.key}`);
  },
};
