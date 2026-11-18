import { apiClient } from '../../api/client';
import type { AttendanceSource, BookingSource } from '../trainer-activity/trainer-activity.api';
import type { AdminReview } from '../trainer-reviews/admin-trainer-reviews.api';

export interface PerformancePage<T> { items: T[]; page: number; limit: number; total: number; totalPages: number }
export interface PerformanceMetrics {
  plannedMilliseconds: string | null; plannedHours: string | null; completedShiftHours: string | null;
  completedBookingMilliseconds: string | null; completedBookingHours: string | null;
  knownActualHours: string; actualTotalHours: string | null; knownPlannedHours: string; knownCompletedBookingHours: string;
  shiftCount: number | null; completedShiftCount: number | null; completedBookingCount: number | null; missingCount: number; openCount: number;
  overlappingShiftCount: number; overlappingBookingCount: number; invalidSourceCount: number;
  utilizationRate: number | null; utilizationStatus: 'AVAILABLE' | 'NOT_APPLICABLE' | 'DATA_INCONSISTENT';
  reviewCount: number | null; averageRating: number | null; ratingDistribution: Record<string, number> | null;
  dataQuality: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE'; warningCodes: string[]; invalidRecordCount: number;
}
export interface PerformanceTrainer { id: string; displayName: string | null; status: string | null }
export interface PerformanceRow extends PerformanceTrainer { summary: PerformanceMetrics }
export interface PerformanceContext {
  range: { fromDate: string; toDate: string; timezone: string; start: string; endExclusive: string; effectiveTo: string; isOngoing: boolean };
  observedAt: string; metricVersion: string; dataQuality: string; warningCodes: string[]; invalidRecordCount: number;
}
export interface PerformanceList extends PerformanceContext, PerformancePage<PerformanceRow> {
  totals: PerformanceMetrics; filter: { trainerId: string | null; q: string; qScope: string };
}
export interface PerformanceSource {
  id: string; trainerId: string | null; shiftId: string | null; bookingId: string | null; status: string | null;
  startAt: string | null; endAt: string | null; clippedStartAt: string | null; clippedEndAt: string | null;
  rawMilliseconds: string | null; clippedMilliseconds: string | null; completedAt: string | null;
  recordedAt: string | null; actorId: string | null; rating: number | null; sourceLink: string | null; dataIssue: string[];
}
export type SourceKind = 'shifts' | 'attendance' | 'bookings' | 'reviews';
export interface PerformanceDetail extends PerformanceContext {
  trainer: PerformanceTrainer; summary: PerformanceMetrics; sourcePages: Record<SourceKind, PerformancePage<PerformanceSource>>;
}
export interface PerformanceFilter { trainerId: string; fromDate: string; toDate: string; q: string; page: number }
export interface SourcePages { shiftPage: number; attendancePage: number; bookingPage: number; reviewPage: number }
function params(values: Record<string, string | number>) {
  return new URLSearchParams(Object.entries(values).filter(([, v]) => v !== '').map(([k, v]) => [k, String(v)])).toString();
}
export const trainerPerformanceApi = {
  list: (filter: PerformanceFilter, signal?: AbortSignal) => apiClient.request<PerformanceList>(`/reports/trainers/performance?${params({ ...filter })}`, { signal }),
  detail: (id: string, range: { fromDate: string; toDate: string }, pages: SourcePages, signal?: AbortSignal) => {
    if (!/^[a-f\d]{24}$/i.test(id)) throw new Error('Mã PT không hợp lệ');
    return apiClient.request<PerformanceDetail>(`/reports/trainers/${id}/performance?${params({ ...range, ...pages })}`, { signal });
  },
  source: (source: PerformanceSource, signal?: AbortSignal) => {
    // Never follow arbitrary server/DB URLs. The source endpoint independently authorizes this GET.
    const allowed: string[] = [];
    if (source.shiftId && /^[a-f\d]{24}$/i.test(source.shiftId)) allowed.push(`/api/work-shifts/${source.shiftId}/attendance`);
    if (source.bookingId && /^[a-f\d]{24}$/i.test(source.bookingId)) allowed.push(`/api/admin/pt-bookings/${source.bookingId}`);
    if (source.status === 'SUBMITTED' && /^[a-f\d]{24}$/i.test(source.id)) allowed.push(`/api/admin/trainer-reviews/${source.id}`);
    if (!source.sourceLink || !allowed.includes(source.sourceLink)) throw new Error('Liên kết nguồn không hợp lệ');
    return apiClient.request<AttendanceSource | BookingSource | AdminReview>(source.sourceLink.slice(4), { signal });
  },
};
