import { apiClient } from '../../api/client';

export interface ActivitySummary {
  shiftCount: number; attendanceClosed: number; attendanceOpen: number; attendanceMissing: number; actualMinutesTotal: number;
  bookingCount: number; completedCount: number; cancelledCount: number; pendingCompletionCount: number;
}
export interface ActivityTrainer { id: string; displayName: string | null; status: string | null; dataIssue: string[]; summary: ActivitySummary }
export interface Page<T> { items: T[]; page: number; limit: number; total: number; totalPages: number; asOf: string }
export interface ActivityRange { fromDate: string; toDate: string }
export interface ActivityList extends Page<ActivityTrainer> { range: ActivityRange; summary: ActivitySummary }
export interface ActivityShift {
  id: string; trainerId: string | null; startAt: string | null; endAt: string | null; status: string | null;
  location: string | null; dataIssue: string[];
  attendance: { id: string | null; state: 'MISSING' | 'OPEN' | 'CLOSED'; checkInAt: string | null; checkOutAt: string | null;
    actualMinutes: number | null; recordedBy: string | null; checkedOutBy: string | null; version: number | null;
    lastCorrectedBy: string | null; lastCorrectedAt: string | null };
}
export interface ActivityBooking {
  id: string; trainerId: string | null; memberId: string | null; startAt: string | null; endAt: string | null;
  status: string | null; completedAt: string | null; completedBy: string | null; completionRevision: number | null; dataIssue: string[];
}
export interface ActivityDetail {
  trainer: ActivityTrainer; range: ActivityRange; asOf: string; summary: ActivitySummary;
  shiftsPage: Page<ActivityShift>; bookingsPage: Page<ActivityBooking>;
}
export interface ActivityFilter { trainerId: string; fromDate: string; toDate: string; page: number }
export interface AttendanceEvent {
  id: string | null; action: string; actorId: string | null; occurredAt: string | null; reason: string | null;
  before: { checkInAt: string | null; checkOutAt: string | null; version: number | null } | null;
  after: { checkInAt: string | null; checkOutAt: string | null; version: number | null } | null;
}
export interface AttendanceSource { asOf: string; state: string; shift: ActivityShift; events: AttendanceEvent[] }
export interface BookingSource {
  id: string; startAt: string; endAt: string; status: string; completedAt?: string; completedBy?: string; completionRevision: number;
  quotaSource: { membershipId: string; sessionsUsed: number | null; sessionsQuota: number | null };
  events: { action: string; actorId: string; occurredAt: string; reason?: string; completionRevision?: number;
    usedBefore?: number; usedAfter?: number; beforeStatus: string; afterStatus: string }[];
}
function params(values: Record<string, string | number>) {
  return new URLSearchParams(Object.entries(values).filter(([, value]) => value !== '').map(([key, value]) => [key, String(value)])).toString();
}
function safeId(id: string): string {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new Error('Mã nguồn không hợp lệ');
  return id;
}
export const trainerActivityApi = {
  list: (filter: ActivityFilter, signal?: AbortSignal) => apiClient.request<ActivityList>(`/admin/trainers/activity?${params({ ...filter })}`, { signal }),
  detail: (id: string, range: ActivityRange, shiftPage: number, bookingPage: number, signal?: AbortSignal) =>
    apiClient.request<ActivityDetail>(`/admin/trainers/${safeId(id)}/activity?${params({ ...range, shiftPage, bookingPage })}`, { signal }),
  attendance: (id: string, signal?: AbortSignal) => apiClient.request<AttendanceSource>(`/work-shifts/${safeId(id)}/attendance`, { signal }),
  booking: (id: string, signal?: AbortSignal) => apiClient.request<BookingSource>(`/admin/pt-bookings/${safeId(id)}`, { signal }),
};
