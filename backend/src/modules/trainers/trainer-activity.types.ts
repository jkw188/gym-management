export const ACTIVITY_METRICS = ['shiftCount', 'attendanceClosed', 'attendanceOpen', 'attendanceMissing',
  'actualMinutesTotal', 'bookingCount', 'completedCount', 'cancelledCount', 'pendingCompletionCount'] as const;
export type ActivitySummary = Record<typeof ACTIVITY_METRICS[number], number>;
export const emptyActivitySummary = (): ActivitySummary => Object.fromEntries(ACTIVITY_METRICS.map(key => [key, 0])) as ActivitySummary;

export interface ActivityTrainer {
  id: string;
  displayName: string | null;
  status: string | null;
  dataIssue: string[];
  summary: ActivitySummary;
}
export interface ActivityRange { fromDate: string; toDate: string; from: Date; to: Date }
export interface ActivityPage<T> { items: T[]; page: number; limit: number; total: number; totalPages: number; asOf: string }
export interface ActivityShift {
  id: string; trainerId: string | null; startAt: string | null; endAt: string | null; status: string | null;
  location: string | null; dataIssue: string[];
  attendance: {
    id: string | null; state: 'MISSING' | 'OPEN' | 'CLOSED'; checkInAt: string | null; checkOutAt: string | null;
    actualMinutes: number | null; recordedBy: string | null; checkedOutBy: string | null;
    version: number | null; lastCorrectedBy: string | null; lastCorrectedAt: string | null;
  };
}
export interface ActivityBooking {
  id: string; trainerId: string | null; memberId: string | null; startAt: string | null; endAt: string | null;
  status: string | null; completedAt: string | null; completedBy: string | null; completionRevision: number | null;
  dataIssue: string[];
}
export interface ActivityList extends ActivityPage<ActivityTrainer> {
  range: { fromDate: string; toDate: string }; summary: ActivitySummary;
}
export interface ActivityDetail {
  trainer: ActivityTrainer; range: { fromDate: string; toDate: string }; asOf: string; summary: ActivitySummary;
  shiftsPage: ActivityPage<ActivityShift>; bookingsPage: ActivityPage<ActivityBooking>;
}
